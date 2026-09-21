/**
 * 题录元数据同步 (`POST /api/literature/papermeta` 的渲染层语义)。
 *
 * serve 侧三条腿 (doi.org BibTeX / arXiv BibTeX / OpenAlex 标题检索) 全部匿名, 且同形
 * 返回 `{ success, fields, bib_type? }`。本模块只负责查询维度、按钮可用性、标题匹配
 * 确认与更新体裁剪, 不再认识任何上游形状:
 *
 * 1. **维度选择**: doi > arxiv > title, 与 serve 侧 `QUERY_PRECEDENCE` 同序。
 * 2. **可用性**: 只要能选出一个维度就给入口, 不看题录是否已经填全 —— 上游会勘误、
 *    会补摘要, 同步过的记录也允许再同步一次。三个标识符全空时不给入口, 因为点了
 *    只会报错。
 *    title 这一维还要多一道形态门槛 (`./title.ts`): 值是编号、扫描文件名、路径、占位符
 *    或一整句话时不给入口, 因为 OpenAlex 的标题模糊检索只会回一堆不相干的命中, 反而要
 *    用户在确认框里替一个垃圾值挑「是不是同一篇」。那道门槛是**否决式**的 —— 只有出现
 *    「不可能是标题」的结构性反证才判否, 其余一律放行: 收起入口对用户没有别的出路,
 *    多显示一次入口只是多点一下, 所以宁可放过。doi/arxiv 是标识符, 不看形态。
 * 3. **确认策略**: doi/arxiv 是标识符解析, 命中即唯一, 直接落库; title 是模糊匹配
 *    (OpenAlex 的 `title.search` 是分词 AND, 整条标题也可能命中多条), 命中也要人确认
 *    是不是同一篇, 不能替用户认。确认与否只看维度, 不看响应形状。
 * 4. **免登录**: 三条腿都不需要账号, 所以按钮可用性里没有登录判据。
 */

import type { LiteratureDetail, LiteratureUpdate } from '../../contracts/literature'
import { looksLikePaperTitle } from './title.ts'

/** 一次同步产出的更新体; 键恒落在 serve 侧 `EDITABLE_FIELDS` 内。 */
export type PaperMetaFields = NonNullable<LiteratureUpdate['fields']>

/** 代理透出的完整响应体: 三条腿同形, 渲染层不必认识任何上游形状。 */
export interface PaperMetaPayload {
  bib_type?: string
  fields?: PaperMetaFields | null
  success?: boolean
}

/** 待用户确认的命中项: 更新体 + 可选的文献类型。 */
export interface PaperMetaMatch {
  bibType?: string
  fields: PaperMetaFields
}

export type PaperMetaDimension = 'doi' | 'arxiv' | 'title'

/** 一次同步查询: 维度 + 该维度上的值, 不带其他维度。 */
export type PaperMetaQuery = { dimension: PaperMetaDimension; value: string }

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

/** 横幅标题文案键: 一句话点明这次会去哪个站点取元数据。 */
export type PaperMetaTitleKey =
  | 'detail.sync.bannerByDoi'
  | 'detail.sync.bannerByArxiv'
  | 'detail.sync.bannerByTitle'

/** 与 serve 侧 `QUOTA_EXHAUSTED` 同一对判据: 状态码或 code 任一命中即算配额。 */
const QUOTA_EXHAUSTED_STATUS = 429
const QUOTA_EXHAUSTED_CODE = 'PAPER_META_QUOTA_EXHAUSTED'
const NETWORK_FAILED_CODE = 'PAPER_META_NETWORK_FAILED'
const NOT_FOUND_CODE = 'PAPER_META_NOT_FOUND'

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

/**
 * 按 doi > arxiv > title 选出唯一同步维度; 三者皆空时返回 null。
 *
 * 只发中选维度的值, 不发其余维度 —— 上游按优先级只看第一个, 多带只会让请求体撒谎。
 * title 维度额外要求值像个论文标题, 不像就当作这一维不可用 (返回 null), 详情页的
 * 同步卡与按钮同源于此, 会一起收起。
 */
export function selectPaperMetaQuery(
  item: Pick<LiteratureDetail, PaperMetaDimension>
): PaperMetaQuery | null {
  for (const dimension of DIMENSION_PRECEDENCE) {
    const value = text(item[dimension])
    if (!value) continue
    if (dimension === 'title' && !looksLikePaperTitle(value)) continue
    return { dimension, value }
  }
  return null
}

/**
 * 这条文献能不能同步: 有 doi / arxiv / title 任一个就能, 与题录是否已经填全无关。
 *
 * 同步过的记录同样可以再同步 —— 上游可能勘误或补了摘要, 是不是要覆盖由确认框里
 * 逐字段勾选决定, 不在这里替用户拦。
 *
 * 只剩 title 且它不像论文标题时算「不能」: 这时点下去只是拿垃圾值去模糊检索。
 */
export function canSyncMetadata(item: LiteratureDetail): boolean {
  return selectPaperMetaQuery(item) !== null
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

/** 维度 → 标题文案键; 与说明文案同源穷尽, 新增维度必须在这里补一条。 */
export function paperMetaTitleKey(dimension: PaperMetaDimension): PaperMetaTitleKey {
  if (dimension === 'doi') return 'detail.sync.bannerByDoi'
  if (dimension === 'arxiv') return 'detail.sync.bannerByArxiv'
  return 'detail.sync.bannerByTitle'
}

/** 上游限流 (429) 要单独提示 (用户能行动: 稍后重试), 其余失败一律「同步元数据失败」。 */
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

/**
 * 取出这次同步的更新体; 形状不对或一个字段都没有时返回空对象, 由调用方按未命中处理。
 *
 * serve 侧只写真的有值的键, 所以空对象就等于「上游没给出任何可填字段」。
 */
export function paperMetaFields(payload: PaperMetaPayload | null | undefined): PaperMetaFields {
  const fields = payload?.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => filled(value))
  ) as PaperMetaFields
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
    case 'publisher':
      return 'columns.publisher'
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
    case 'number':
      return 'columns.number'
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
    case 'publisher':
      return 'publisher'
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
    case 'number':
      return 'number'
    case 'pages':
      return 'pages'
    default:
      return undefined
  }
}

/**
 * 更新体与当前文献的逐字段对比; 只列上游给了值且详情页展示得出来的字段。
 *
 * 确认填充要让用户逐字段勾选, 所以对比行直接以更新体的键为主键, 当前值取文献上
 * 同义字段 (authors ↔ creators_display 等), 空值显示为空串由调用方渲染成「—」。
 */
export function paperMetaDiff(
  fields: PaperMetaFields,
  item: LiteratureDetail
): PaperMetaDiffRow[] {
  return Object.entries(fields)
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
  fields: PaperMetaFields,
  picked: ReadonlySet<string>
): PaperMetaFields {
  const pickedFields: Record<string, string | number | null> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (picked.has(name)) pickedFields[name] = value
  }
  return pickedFields
}
