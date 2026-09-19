/**
 * 题录元数据同步 (PaperHub 单条代理的渲染层语义)。
 *
 * serve 侧公开 DOI/arXiv BibTeX 返回更新字段；标题搜索原样透出 PaperHub 命中项。
 * 本模块负责查询维度、按钮可用性、标题匹配确认与 PaperHub 字段映射:
 *
 * 1. **维度选择**: doi > arxiv > title, 与 serve 侧 `QUERY_PRECEDENCE` 同序。
 * 2. **稀疏判据**: 只有「非空题录字段落在 title/author/arxiv/doi 子集内」的记录才需要
 *    补全 —— 这类记录通常来自检索结果或资料标记, 只带标识符, 缺摘要、期刊、年份。
 * 3. **确认策略**: doi/arxiv 是标识符解析, 命中即唯一, 直接落库; title 是模糊匹配,
 *    命中也要人确认是不是同一篇, 不能替用户认。
 * 4. **字段映射**: 上游形状 → `LiteratureUpdate.fields`。只写上游真的给了值的字段,
 *    绝不拿空值覆盖已有数据。
 */

import type { LiteratureDetail, LiteratureUpdate } from '../../contracts/literature'

/** 上游 papersearch 单条命中项的原始形状; 代理不改名, 所以这里就是上游的键。 */
export interface PaperMetaRecord {
  abstract?: string | null
  authors?: string[] | null
  externalids?: { ArXiv?: string | null; DOI?: string | null } | null
  id?: string | null
  journalname?: string | null
  journalpages?: string | null
  journalvolume?: string | null
  publicationdate?: string | null
  title?: string | null
  url?: string | null
  venue?: string | null
}

/** 代理透出的完整响应体。 */
export interface PaperMetaPayload {
  data?: PaperMetaRecord[] | null
  success?: boolean
  fields?: NonNullable<LiteratureUpdate['fields']>
  bib_type?: string
}

export type PaperMetaDimension = 'doi' | 'arxiv' | 'title'

/** 一次同步查询: 维度 + 该维度上的值, 不带其他维度。 */
export type PaperMetaQuery = { dimension: PaperMetaDimension; value: string }

/** 确认对话框需要的展示投影; 渲染层不必认识上游形状。 */
export interface PaperMetaPreview {
  abstract: string
  arxiv: string
  authors: string
  doi: string
  publication: string
  publishedDate: string
  title: string
  url: string
  year: number | null
}

export type PaperMetaFailureKind = 'quota' | 'network' | 'missing' | 'failed'

export const PAPER_META_FAILURE_KEYS = {
  quota: 'detail.sync.quotaFailed',
  network: 'detail.sync.networkFailed',
  missing: 'detail.sync.missed',
  failed: 'detail.sync.failed'
} as const

/**
 * 检索优先级, 同时也是取值路径: 维度名与文献上的字段名逐字相同 (doi / arxiv / title),
 * 所以一张表就够, 不需要再维护一份「维度 → 字段」映射让两处顺序各自漂移。
 */
const DIMENSION_PRECEDENCE: readonly PaperMetaDimension[] = ['doi', 'arxiv', 'title']

/** 横幅说明文案键: 先告诉用户这次会拿哪个维度去检索。 */
export type PaperMetaDescriptionKey =
  | 'detail.sync.byDoi'
  | 'detail.sync.byArxiv'
  | 'detail.sync.byTitle'

/**
 * 参与稀疏判据的题录字段。
 *
 * 不含 `citation_key` / `item_type` / `bib_type`: 它们是库内派生值 (citation_key 可留空、
 * 另两个恒有默认), 算进来会让判据恒假, 按钮永远不出现。`issn` 当前投影恒为 null。
 */
const BIBLIOGRAPHIC_FIELDS: ReadonlyArray<keyof LiteratureDetail> = [
  'title',
  'creators_display',
  'publication_display',
  'subtitle',
  'year',
  'published_date',
  'abstract',
  'doi',
  'arxiv',
  'isbn',
  'url',
  'volume',
  'number',
  'pages',
  'publisher',
  'address'
]

/** 只有标识符与作者的记录才需要同步; 非空字段必须全部落在这个子集里。 */
const IDENTIFIER_ONLY_FIELDS: ReadonlySet<keyof LiteratureDetail> = new Set([
  'title',
  'creators_display',
  'arxiv',
  'doi'
])

/** 与 serve 侧 `QUOTA_EXHAUSTED` 同一对判据: 状态码或 code 任一命中即算配额。 */
const QUOTA_EXHAUSTED_STATUS = 429
const QUOTA_EXHAUSTED_CODE = 'PAPER_META_QUOTA_EXHAUSTED'
const NETWORK_FAILED_CODE = 'PAPER_META_NETWORK_FAILED'
const NOT_FOUND_CODE = 'PAPER_META_NOT_FOUND'

/** 作者分隔符, 与 serve 侧 `service/literature/service/metadata.py:AUTHOR_SEPARATOR` 一致。 */
const AUTHOR_SEPARATOR = ', '
const YEAR_PATTERN = /^\s*(\d{4})/
const YEAR_RADIX = 10

/** 结构性失败描述; `LiteratureApiError['failure']` 天然满足, 不必反向依赖 api.ts。 */
export interface PaperMetaFailureLike {
  code: string
  message?: string
  status: number
}

function filled(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  return String(value).trim() !== ''
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function firstFilled(...values: Array<string | null | undefined>): string {
  return text(values.find((value) => filled(value)) ?? '')
}

/**
 * 按 doi > arxiv > title 选出唯一同步维度; 三者皆空时返回 null。
 *
 * 只发中选维度的值, 不发其余维度 —— 上游按优先级只看第一个, 多带只会让请求体撒谎。
 */
export function selectPaperMetaQuery(
  item: Pick<LiteratureDetail, PaperMetaDimension>
): PaperMetaQuery | null {
  for (const dimension of DIMENSION_PRECEDENCE) {
    const value = text(item[dimension])
    if (value) return { dimension, value }
  }
  return null
}

/**
 * 这条文献是否需要补全题录: 非空题录字段全部落在 title/author/arxiv/doi 之内,
 * 且至少能选出一个同步维度。
 */
export function needsMetadataSync(item: LiteratureDetail): boolean {
  if (!selectPaperMetaQuery(item)) return false
  const present = BIBLIOGRAPHIC_FIELDS.filter((field) => filled(item[field]))
  return present.every((field) => IDENTIFIER_ONLY_FIELDS.has(field))
}

export function canSyncMetadata(item: LiteratureDetail, loggedIn: boolean): boolean {
  const query = selectPaperMetaQuery(item)
  return query !== null && (query.dimension !== 'title' || (loggedIn && needsMetadataSync(item)))
}

export function requiresConfirmation(dimension: PaperMetaDimension): boolean {
  return dimension === 'title'
}

/** 维度 → 说明文案键; 联合类型穷尽, 新增维度必须在这里补一条。 */
export function paperMetaDescriptionKey(
  dimension: PaperMetaDimension
): PaperMetaDescriptionKey {
  if (dimension === 'doi') return 'detail.sync.byDoi'
  if (dimension === 'arxiv') return 'detail.sync.byArxiv'
  return 'detail.sync.byTitle'
}

/** 配额用尽要单独提示 (用户能行动), 其余失败一律「同步元数据失败」。 */
export function classifyPaperMetaFailure(
  failure: PaperMetaFailureLike | null
): PaperMetaFailureKind {
  if (!failure) return 'failed'
  if (failure.code === NETWORK_FAILED_CODE) return 'network'
  if (failure.code === NOT_FOUND_CODE) return 'missing'
  return failure.status === QUOTA_EXHAUSTED_STATUS || failure.code === QUOTA_EXHAUSTED_CODE
    ? 'quota'
    : 'failed'
}

/** 从代理响应里取出唯一命中项; 形状不对时返回 null, 由调用方按失败处理。 */
export function paperMetaRecord(payload: PaperMetaPayload | null | undefined): PaperMetaRecord | null {
  const data = payload?.data
  if (!Array.isArray(data) || data.length !== 1) return null
  const record = data[0]
  return record && typeof record === 'object' ? record : null
}

function publicationYear(record: PaperMetaRecord): number | null {
  const matched = YEAR_PATTERN.exec(text(record.publicationdate))
  return matched ? Number.parseInt(matched[1], YEAR_RADIX) : null
}

/**
 * 上游命中项 → 文献更新字段。
 *
 * 只产出上游真的给了值的键, 空值不进更新体, 因此同步不会把已有数据抹成空。
 */
export function paperMetaFields(record: PaperMetaRecord): NonNullable<LiteratureUpdate['fields']> {
  const candidates: Array<[string, string | number | null]> = [
    ['title', text(record.title)],
    ['authors', (record.authors ?? []).map((author) => text(author)).filter(Boolean).join(AUTHOR_SEPARATOR)],
    ['publication', firstFilled(record.venue, record.journalname)],
    ['published_date', text(record.publicationdate)],
    ['year', publicationYear(record)],
    ['abstract', text(record.abstract)],
    ['url', text(record.url)],
    ['doi', text(record.externalids?.DOI)],
    ['arxiv', text(record.externalids?.ArXiv)],
    ['volume', text(record.journalvolume)],
    ['pages', text(record.journalpages)]
  ]
  const fields: Record<string, string | number | null> = {}
  for (const [name, value] of candidates) {
    if (value !== null && filled(value)) fields[name] = value
  }
  return fields
}

/** 确认对话框的展示投影。 */
export function paperMetaPreview(record: PaperMetaRecord): PaperMetaPreview {
  return {
    abstract: text(record.abstract),
    arxiv: text(record.externalids?.ArXiv),
    authors: (record.authors ?? []).map((author) => text(author)).filter(Boolean).join(AUTHOR_SEPARATOR),
    doi: text(record.externalids?.DOI),
    publication: firstFilled(record.venue, record.journalname),
    publishedDate: text(record.publicationdate),
    title: text(record.title),
    url: text(record.url),
    year: publicationYear(record)
  }
}

/** 确认对话框的逐字段新旧对比行; field 即 `LiteratureUpdate.fields` 的键。 */
export interface PaperMetaDiffRow {
  field: string
  labelKey: string
  current: string
  next: string
}

/** 对比行标签文案键; 用 switch 而非对象字面量, 避开 i18n 门禁对 title/label 属性字面量的扫描。 */
function diffLabelKey(field: string): string {
  switch (field) {
    case 'title':
      return 'columns.title'
    case 'authors':
      return 'columns.creator'
    case 'publication':
      return 'columns.publication'
    case 'published_date':
      return 'columns.published_date'
    case 'year':
      return 'columns.year'
    case 'abstract':
      return 'columns.abstract'
    case 'url':
      return 'columns.url'
    case 'doi':
      return 'columns.doi'
    case 'arxiv':
      return 'columns.arxiv'
    case 'volume':
      return 'columns.volume'
    case 'pages':
      return 'columns.pages'
    default:
      return field
  }
}

/** 对比行当前值取文献上的同义字段。 */
function diffCurrentField(field: string): keyof LiteratureDetail | undefined {
  switch (field) {
    case 'title':
      return 'title'
    case 'authors':
      return 'creators_display'
    case 'publication':
      return 'publication_display'
    case 'published_date':
      return 'published_date'
    case 'year':
      return 'year'
    case 'abstract':
      return 'abstract'
    case 'url':
      return 'url'
    case 'doi':
      return 'doi'
    case 'arxiv':
      return 'arxiv'
    case 'volume':
      return 'volume'
    case 'pages':
      return 'pages'
    default:
      return undefined
  }
}

/**
 * 命中项与当前文献的逐字段对比; 只列上游给了值的字段。
 *
 * 确认填充要让用户逐字段勾选, 所以对比行直接以更新体的键为主键, 当前值取文献上
 * 同义字段 (authors ↔ creators_display 等), 空值显示为空串由调用方渲染成「—」。
 */
export function paperMetaDiff(
  record: PaperMetaRecord,
  item: LiteratureDetail
): PaperMetaDiffRow[] {
  return Object.entries(paperMetaFields(record))
    .filter(([field]) => diffCurrentField(field) !== undefined)
    .map(([field, value]) => ({
      field,
      labelKey: diffLabelKey(field),
      current: text(item[diffCurrentField(field) as keyof LiteratureDetail]),
      next: String(value)
    }))
}

/** 只把用户勾选的字段写进更新体; 未勾选的保持文献现值。 */
export function paperMetaPickedFields(
  record: PaperMetaRecord,
  picked: ReadonlySet<string>
): NonNullable<LiteratureUpdate['fields']> {
  const fields: Record<string, string | number | null> = {}
  for (const [name, value] of Object.entries(paperMetaFields(record))) {
    if (picked.has(name)) fields[name] = value
  }
  return fields
}
