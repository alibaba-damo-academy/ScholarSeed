import type { TFunction } from 'i18next'
import type { createFormatters } from '../../../../localization/format'
import type { LiteratureReview, LiteratureSummary } from '../../contracts/literature'

export const REVIEW_STATUS = {
  outline: 'reviewProjection.outline', generated: 'reviewProjection.result', partial: 'reviewProjection.result',
  incomplete: 'reviewProjection.result', failed: 'reviewProjection.result'
} as const
export const REVIEW_VERDICTS = {
  PASS: 'reviewProjection.verdict.PASS', WARN: 'reviewProjection.verdict.WARN', FAIL: 'reviewProjection.verdict.FAIL', NOT_CHECKED: 'reviewProjection.verdict.NOT_CHECKED', NOT_APPLICABLE: 'reviewProjection.verdict.NOT_APPLICABLE'
} as const

const GENERATION_LABELS = { SUCCESS: 'reviewProjection.generation.SUCCESS', PARTIAL_SUCCESS: 'reviewProjection.generation.PARTIAL_SUCCESS', FAILED: 'reviewProjection.generation.FAILED' } as const
const GENERATION_STATUSES = new Set(Object.keys(GENERATION_LABELS))
const REVIEW_CHECKPOINTS = new Set<string>(['outline', 'result'])
const PRECISE_SEARCH_ORIGIN = 'precise-search'
const OUTPUT_FORMATS = new Set(['latex_pdf', 'markdown', null])
const CITATION_STYLES = new Set(['numeric', 'author_year', 'ieee', 'acm', null])
const DECISION_SOURCES = new Set(['user', 'default', null])

/** 时间列展示到秒(中文即 2026/9/15 15:46:32), 同一天内多次导入或更新才能区分先后。 */
export const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'medium' }

/** 无法解析的时间返回空串, 由调用方决定占位文案。 */
export function timestampLabel(value: string, format: ReturnType<typeof createFormatters>): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '' : format.date(time, TIMESTAMP_FORMAT)
}

export function latestLiteratureSummary<T extends LiteratureSummary>(
  current: T,
  candidate: T
): T {
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
  local: ReadonlyMap<string, LiteratureSummary>
): LiteratureSummary[] {
  return fetched.map((item) => {
    const candidate = local.get(item.id)
    return candidate && candidate.version >= item.version ? candidate : item
  })
}

export function reviewStatus(review: LiteratureReview, t: TFunction<'literature'>): string {
  return review.generation_status
    ? t('reviewProjection.generationStatus', { status: t(GENERATION_LABELS[review.generation_status]) })
    : t(REVIEW_STATUS[review.status])
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isOptionalCount = (value: unknown): boolean => value === null || isCount(value)

export function reviewSupersessionKey(value: Record<string, unknown>): string | null {
  return typeof value.workspace === 'string' && value.workspace
    && typeof value.checkpoint === 'string' && REVIEW_CHECKPOINTS.has(value.checkpoint)
    ? value.workspace
    : null
}

export function searchSupersessionKey(value: Record<string, unknown>): string | null {
  if (value.origin !== PRECISE_SEARCH_ORIGIN
    || typeof value.session_id !== 'string' || !value.session_id.trim()
    || typeof value.run_id !== 'string' || !value.run_id.trim()
    || !isCount(value.round) || (value.round as number) < 1) return null
  return JSON.stringify([value.session_id, value.origin, value.run_id, value.round])
}

export function parseReview(value: Record<string, unknown>): LiteratureReview | null {
  if (value.schema_version !== '1.1' || typeof value.session_id !== 'string' || !value.session_id
    || typeof value.workspace !== 'string' || typeof value.title !== 'string' || typeof value.intent !== 'string'
    || typeof value.checkpoint !== 'string' || !REVIEW_CHECKPOINTS.has(value.checkpoint)
    || typeof value.status !== 'string' || !Object.prototype.hasOwnProperty.call(REVIEW_STATUS, value.status)
    || (value.generation_status != null && (typeof value.generation_status !== 'string' || !GENERATION_STATUSES.has(value.generation_status)))
    || ![value.included, value.fulltext, value.abstract_only, value.pending_checks, value.cited].every(isOptionalCount) || !isCount(value.section_count)
    || !isStrings(value.warnings) || !isRecord(value.source_hashes)
    || !isRecord(value.scope) || typeof value.scope.topic !== 'string' || typeof value.scope.time_range !== 'string'
    || !isStrings(value.scope.focus) || !isStrings(value.scope.requested_materials)
    || !isOptionalCount(value.scope.project_materials) || !isOptionalCount(value.scope.external_materials)
    || !isRecord(value.output) || !OUTPUT_FORMATS.has(value.output.format as string | null)
    || !CITATION_STYLES.has(value.output.citation_style as string | null)
    || !DECISION_SOURCES.has(value.output.decided_by as string | null)
    || !Array.isArray(value.sections) || !value.sections.every(section => isRecord(section)
      && typeof section.id === 'string' && typeof section.title === 'string' && typeof section.description === 'string'
      && isCount(section.papers) && isStrings(section.children) && isStrings(section.comparison_tables))
    || !Array.isArray(value.citations) || !value.citations.every(citation => isRecord(citation)
      && typeof citation.title === 'string' && typeof citation.authors === 'string'
      && (citation.year === null || typeof citation.year === 'number') && typeof citation.venue === 'string')
    || !Array.isArray(value.abstract_evidence) || !value.abstract_evidence.every(evidence => isRecord(evidence)
      && typeof evidence.paper_id === 'string' && typeof evidence.title === 'string' && typeof evidence.reason === 'string')
    || !Array.isArray(value.checks) || !value.checks.every(check => isRecord(check)
      && typeof check.title === 'string' && typeof check.reason === 'string'
      && typeof check.verdict === 'string' && Object.prototype.hasOwnProperty.call(REVIEW_VERDICTS, check.verdict))
    || !Array.isArray(value.issues) || !value.issues.every(issue => isRecord(issue)
      && typeof issue.title === 'string' && typeof issue.detail === 'string'
      && isStrings(issue.paper_ids) && typeof issue.affected_content === 'string')
    || !Array.isArray(value.artifacts) || !value.artifacts.every(artifact => isRecord(artifact)
      && ['artifact_id', 'path', 'name', 'title', 'sha256'].every(key => typeof artifact[key] === 'string'))) return null
  return value as unknown as LiteratureReview
}
