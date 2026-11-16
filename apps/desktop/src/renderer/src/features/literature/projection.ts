import type { TFunction } from 'i18next'
import type { createFormatters } from '../../../../localization/format'
import type {
  LiteratureReview,
  LiteratureSummary,
  ReviewCitation,
  ReviewEvidence,
} from '../../contracts/literature'
import { CITATIONS_ORIGIN } from './result.ts'

export function literatureCollections(
  item: LiteratureSummary,
  projectId?: string
): LiteratureSummary['collections'] {
  return projectId ? item.project_collections : item.collections
}

export const REVIEW_STATUS = {
  outline: 'reviewProjection.outline',
  generated: 'reviewProjection.result',
  partial: 'reviewProjection.result',
  incomplete: 'reviewProjection.result',
  failed: 'reviewProjection.result',
} as const
export const REVIEW_VERDICTS = {
  PASS: 'reviewProjection.verdict.PASS',
  WARN: 'reviewProjection.verdict.WARN',
  FAIL: 'reviewProjection.verdict.FAIL',
  NOT_CHECKED: 'reviewProjection.verdict.NOT_CHECKED',
  NOT_APPLICABLE: 'reviewProjection.verdict.NOT_APPLICABLE',
} as const

const GENERATION_LABELS = {
  SUCCESS: 'reviewProjection.generation.SUCCESS',
  PARTIAL_SUCCESS: 'reviewProjection.generation.PARTIAL_SUCCESS',
  FAILED: 'reviewProjection.generation.FAILED',
} as const
const GENERATION_STATUSES = new Set(Object.keys(GENERATION_LABELS))
const REVIEW_CHECKPOINTS = new Set<string>(['outline', 'result'])
const PRECISE_SEARCH_ORIGIN = 'precise-search'
const SUPERSEDED_SEARCH_ORIGINS = new Set([PRECISE_SEARCH_ORIGIN, CITATIONS_ORIGIN])
export const REVIEW_FORMAT_LABELS = {
  latex_pdf: 'PDF',
  markdown: 'Markdown',
  docx: 'DOCX',
} as const satisfies Record<NonNullable<LiteratureReview['output']['format']>, string>
const OUTPUT_FORMATS = new Set<string | null>([...Object.keys(REVIEW_FORMAT_LABELS), null])
const CITATION_STYLES = new Set(['numeric', 'author_year', 'ieee', 'acm', 'gbt7714_2025', null])
const DECISION_SOURCES = new Set(['user', 'default', null])

export const REVIEW_EVIDENCE_BASIS_LABELS = {
  fulltext: 'review.evidenceBasisLabel.fulltext',
  abstract: 'review.evidenceBasisLabel.abstract',
  unknown: 'review.evidenceBasisLabel.unknown',
} as const

export function reviewCitationTitle(citation: ReviewCitation): string {
  return citation.number ? `${citation.number}. ${citation.title}` : citation.title
}

const FULLTEXT_LIMITATIONS = [
  {
    code: 'not_in_paperhub',
    reason: '全文来源暂未返回可下载文件，仅使用摘要证据',
    messageKey: 'review.fulltextLimitations.notInPaperhub',
  },
  {
    code: 'auth_failed',
    reason: '全文服务认证失败',
    messageKey: 'review.fulltextLimitations.authFailed',
  },
  {
    code: 'fetch_failed',
    reason: '全文服务暂时不可用',
    messageKey: 'review.fulltextLimitations.fetchFailed',
  },
  {
    code: 'extract_failed',
    reason: '全文解析失败',
    messageKey: 'review.fulltextLimitations.extractFailed',
  },
  {
    code: 'too_large',
    reason: '全文文件超过可处理大小限制',
    messageKey: 'review.fulltextLimitations.tooLarge',
  },
  {
    code: 'not_a_pdf',
    reason: '全文格式无法解析',
    messageKey: 'review.fulltextLimitations.notAPdf',
  },
  {
    code: '',
    reason: '未取得全文，只能支持题录或摘要层判断',
    messageKey: 'review.fulltextLimitations.unavailable',
  },
] as const

export function reviewEvidenceReason(evidence: ReviewEvidence, t: TFunction<'literature'>): string {
  const limitation = evidence.reason_code
    ? FULLTEXT_LIMITATIONS.find((item) => item.code === evidence.reason_code)
    : FULLTEXT_LIMITATIONS.find((item) => item.reason === evidence.reason)
  if (limitation) return t(limitation.messageKey)
  return evidence.reason_code ? t('review.fulltextLimitations.unavailable') : evidence.reason
}

/** 时间列展示到秒(中文即 2026/9/15 15:46:32), 同一天内多次导入或更新才能区分先后。 */
export const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: 'short',
  timeStyle: 'medium',
}

/** 无法解析的时间返回空串, 由调用方决定占位文案。 */
export function timestampLabel(value: string, format: ReturnType<typeof createFormatters>): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '' : format.date(time, TIMESTAMP_FORMAT)
}

export function latestLiteratureSummary<T extends LiteratureSummary>(current: T, candidate: T): T {
  return candidate.version >= current.version ? candidate : current
}

export function replaceLiteratureSummary(
  items: LiteratureSummary[],
  candidate: LiteratureSummary
): LiteratureSummary[] {
  const index = items.findIndex((item) => item.id === candidate.id)
  if (index < 0) return items
  const replacement = latestLiteratureSummary(items[index], candidate)
  if (replacement === items[index]) return items
  const next = [...items]
  next[index] = replacement
  return next
}

export function mergeLiteratureSummaries(
  fetched: LiteratureSummary[],
  local: ReadonlyMap<string, LiteratureSummary>,
  preferLocalOnEqual = true
): LiteratureSummary[] {
  return fetched.map((item) => {
    const candidate = local.get(item.id)
    return candidate &&
      (candidate.version > item.version ||
        (preferLocalOnEqual && candidate.version === item.version))
      ? candidate
      : item
  })
}

export function reviewStatus(review: LiteratureReview, t: TFunction<'literature'>): string {
  return review.generation_status
    ? t('reviewProjection.generationStatus', {
        status: t(GENERATION_LABELS[review.generation_status]),
      })
    : t(REVIEW_STATUS[review.status])
}

export function reviewNotice(review: LiteratureReview): 'incomplete' | 'verification' | null {
  if (review.checkpoint !== 'result') return null
  const generated = review.generation_status
    ? review.generation_status === 'SUCCESS'
    : review.status === 'generated'
  if (!generated) return 'incomplete'
  return !review.verification.rows.some((row) => row.check) ||
    review.verification.rows.some(
      ({ check, issue }) =>
        issue !== null || (check && check.verdict !== 'PASS' && check.verdict !== 'NOT_APPLICABLE')
    ) ||
    (review.verification.issue_count ?? 0) > 0
    ? 'verification'
    : null
}

export function reviewIssueSummary(review: LiteratureReview): {
  total: number | null
  shown: number
  hidden: number
} {
  const shown = review.verification.rows.filter((row) => row.issue !== null).length
  const total = review.verification.issue_count
  return { total, shown, hidden: Math.max(0, (total ?? shown) - shown) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const isCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isOptionalCount = (value: unknown): boolean => value === null || isCount(value)

export function reviewSupersessionKey(value: Record<string, unknown>): string | null {
  return typeof value.workspace === 'string' &&
    value.workspace &&
    typeof value.checkpoint === 'string' &&
    REVIEW_CHECKPOINTS.has(value.checkpoint)
    ? value.workspace
    : null
}

export function searchSupersessionKey(value: Record<string, unknown>): string | null {
  if (
    typeof value.origin !== 'string' ||
    !SUPERSEDED_SEARCH_ORIGINS.has(value.origin) ||
    typeof value.session_id !== 'string' ||
    !value.session_id.trim() ||
    typeof value.run_id !== 'string' ||
    !value.run_id.trim() ||
    !isCount(value.round) ||
    (value.round as number) < 1
  )
    return null
  return JSON.stringify([value.session_id, value.origin, value.run_id, value.round])
}

const isNullableCount = (value: unknown): boolean => value === null || isCount(value)

function isReviewReference(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.citation_key !== 'string' ||
    !value.citation_key ||
    !(value.paper_id === null || typeof value.paper_id === 'string') ||
    !isRecord(value.citation)
  )
    return false
  const { citation, evidence, target } = value
  return (
    (citation.number === null || (isCount(citation.number) && citation.number !== 0)) &&
    typeof citation.title === 'string' &&
    typeof citation.authors === 'string' &&
    (citation.year === null || typeof citation.year === 'number') &&
    typeof citation.venue === 'string' &&
    (evidence === null ||
      (isRecord(evidence) &&
        typeof evidence.reason === 'string' &&
        (evidence.reason_code === undefined || typeof evidence.reason_code === 'string') &&
        typeof evidence.basis === 'string' &&
        Object.prototype.hasOwnProperty.call(REVIEW_EVIDENCE_BASIS_LABELS, evidence.basis) &&
        isNullableCount(evidence.extracted_chars))) &&
    (target === null ||
      (isRecord(target) &&
        (target.kind === 'library'
          ? typeof target.item_id === 'string' && Boolean(target.item_id.trim())
          : target.kind === 'web' && isReviewWebUrl(target.url))))
  )
}

function isReviewWebUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

function isVerificationRow(value: unknown): boolean {
  if (!isRecord(value) || (value.check === null && value.issue === null)) return false
  const { check, issue } = value
  return (
    (check === null ||
      (isRecord(check) &&
        typeof check.id === 'string' &&
        typeof check.title === 'string' &&
        typeof check.reason === 'string' &&
        typeof check.verdict === 'string' &&
        Object.prototype.hasOwnProperty.call(REVIEW_VERDICTS, check.verdict))) &&
    (issue === null ||
      (isRecord(issue) &&
        typeof issue.title === 'string' &&
        typeof issue.detail === 'string' &&
        isStrings(issue.paper_ids) &&
        typeof issue.affected_content === 'string' &&
        (issue.priority === null ||
          issue.priority === 'urgent' ||
          issue.priority === 'attention' ||
          issue.priority === 'low')))
  )
}

export function parseReview(value: Record<string, unknown>): LiteratureReview | null {
  if (
    value.schema_version !== '1.2' ||
    typeof value.session_id !== 'string' ||
    !value.session_id ||
    typeof value.workspace !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.intent !== 'string' ||
    typeof value.checkpoint !== 'string' ||
    !REVIEW_CHECKPOINTS.has(value.checkpoint) ||
    typeof value.status !== 'string' ||
    !Object.prototype.hasOwnProperty.call(REVIEW_STATUS, value.status) ||
    (value.generation_status != null &&
      (typeof value.generation_status !== 'string' ||
        !GENERATION_STATUSES.has(value.generation_status))) ||
    ![value.included, value.fulltext, value.abstract_only].every(isOptionalCount) ||
    !isCount(value.section_count) ||
    !isStrings(value.warnings) ||
    !isRecord(value.source_hashes) ||
    !isRecord(value.scope) ||
    !(value.scope.topic === null || typeof value.scope.topic === 'string') ||
    typeof value.scope.time_range !== 'string' ||
    !isStrings(value.scope.focus) ||
    !isStrings(value.scope.requested_materials) ||
    !isOptionalCount(value.scope.project_materials) ||
    !isOptionalCount(value.scope.external_materials) ||
    !isRecord(value.output) ||
    !OUTPUT_FORMATS.has(value.output.format as string | null) ||
    !CITATION_STYLES.has(value.output.citation_style as string | null) ||
    !DECISION_SOURCES.has(value.output.decided_by as string | null) ||
    !Array.isArray(value.sections) ||
    !value.sections.every(
      (section) =>
        isRecord(section) &&
        typeof section.id === 'string' &&
        typeof section.title === 'string' &&
        typeof section.description === 'string' &&
        isCount(section.papers) &&
        isStrings(section.children) &&
        isStrings(section.comparison_tables)
    ) ||
    !isRecord(value.references) ||
    ![
      value.references.cited_count,
      value.references.fulltext_cited_count,
      value.references.abstract_cited_count,
    ].every(isNullableCount) ||
    !Array.isArray(value.references.rows) ||
    !value.references.rows.every(isReviewReference) ||
    !isRecord(value.verification) ||
    !isNullableCount(value.verification.issue_count) ||
    !Array.isArray(value.verification.rows) ||
    !value.verification.rows.every(isVerificationRow) ||
    (typeof value.verification.issue_count === 'number' &&
      value.verification.issue_count <
        value.verification.rows.filter((row) => row.issue !== null).length) ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(
      (artifact) =>
        isRecord(artifact) &&
        ['artifact_id', 'path', 'name', 'title', 'sha256'].every(
          (key) => typeof artifact[key] === 'string'
        )
    )
  )
    return null
  return value as unknown as LiteratureReview
}
