import type { ConversationSearchPaper, LiteratureSearchPaper } from '../../contracts/literature'

export const RESULT_LABELS = {
  success: 'result.status.success',
  partial: 'result.status.partial',
  no_confident_match: 'result.status.no_confident_match',
  source_failed: 'result.status.source_failed',
  execution_blocked: 'result.status.execution_blocked',
  invalid_result: 'result.status.invalid_result',
} as const

export type ResultSort = 'relevance' | 'title' | 'year' | 'citations'
export type AccessFilter = 'all' | 'open' | 'closed'
export type DecisionFilter = 'all' | 'included' | 'excluded'
export type ReviewEvidence = 'fulltext' | 'abstract' | 'metadata' | 'unknown'
const CARD_PRESENTED_REPORT_ORIGINS = new Set(['literature-review', 'precise-search'])
const SEARCH_WARNING_RULES = [
  {
    pattern: /^agentic-search used degraded retrieval \(source_mode=web_only\)$/,
    key: 'result.warning.webOnly',
  },
  {
    pattern: /^agentic-search used degraded retrieval \(source_mode=/,
    key: 'result.warning.degraded',
  },
  { pattern: /^agentic-search returned a partial result$/, key: 'result.warning.partial' },
  { pattern: /^search trace unavailable;/, key: 'result.warning.traceUnavailable' },
  { pattern: /^search abstracts filtered$/, key: 'result.warning.abstractsFiltered' },
  { pattern: /^supplemental search shortfall$/, key: 'result.warning.shortfall' },
  {
    pattern: /^本轮来源或候选池统计未记录，无法核对完整检索过程。$/,
    key: 'result.warning.statisticsUnavailable',
  },
  { pattern: /^检索来源统计未记录。$/, key: 'result.warning.statisticsUnavailable' },
  {
    pattern:
      /^(来源候选数与候选池口径不一致，候选总数无法核对。|候选池统计少于最终保留数量，去重数量无法核对。)$/,
    key: 'result.warning.statisticsInconsistent',
  },
] as const

export function searchWarningKeys(
  warnings: readonly string[]
): ((typeof SEARCH_WARNING_RULES)[number]['key'] | 'result.warning.limited')[] {
  return [
    ...new Set(
      warnings
        .filter((warning) => warning.trim())
        .map(
          (warning) =>
            SEARCH_WARNING_RULES.find((rule) => rule.pattern.test(warning.trim()))?.key ??
            'result.warning.limited'
        )
    ),
  ]
}

export function presentedSearchArtifacts(result: {
  origin?: string
  metadata?: { artifact_id?: string }
  selection?: { artifact_id?: string }
  fulltext?: { artifact_id?: string }
  report?: { artifact_id?: string }
}): readonly string[] {
  return [
    result.metadata?.artifact_id,
    result.selection?.artifact_id,
    result.fulltext?.artifact_id,
    ...(result.origin && CARD_PRESENTED_REPORT_ORIGINS.has(result.origin)
      ? [result.report?.artifact_id]
      : []),
  ].filter((id): id is string => Boolean(id))
}

export function visibleSearchPapers(
  papers: LiteratureSearchPaper[],
  access: AccessFilter,
  sort: ResultSort,
  decision: DecisionFilter = 'all'
): LiteratureSearchPaper[] {
  const reviewResults = papers.some((paper) => paper.decision && paper.decision !== 'candidate')
  const accessFiltered =
    access === 'all'
      ? papers
      : papers.filter((paper) =>
          reviewResults
            ? access === 'open'
              ? paper.fulltext === 'fulltext'
              : paper.fulltext !== 'fulltext'
            : access === 'open'
              ? paper.access === 'open'
              : paper.access !== 'open'
        )
  const filtered =
    decision === 'all'
      ? accessFiltered
      : accessFiltered.filter((paper) => paper.decision === decision)
  return [...filtered].sort((left, right) => {
    if (sort === 'title') return left.title.localeCompare(right.title)
    if (sort === 'year') return (right.year ?? -1) - (left.year ?? -1)
    if (sort === 'citations') return (right.citation_count ?? -1) - (left.citation_count ?? -1)
    return (left.tier ?? Number.MAX_SAFE_INTEGER) - (right.tier ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * Reading depth a review row rests on. The review artifacts only separate
 * "text acquired" from "no text", so an abstract-level paper is metadata-only
 * evidence whenever no abstract survived into the projection.
 */
export function reviewEvidence(paper: LiteratureSearchPaper): ReviewEvidence {
  if (paper.fulltext === 'fulltext') return 'fulltext'
  if (paper.fulltext !== 'abstract') return 'unknown'
  return (paper.abstract || '').trim() ? 'abstract' : 'metadata'
}

function bibValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

export type BibliographyPaper = Pick<LiteratureSearchPaper, 'title' | 'authors' | 'year'> & {
  venue?: string | null
  doi?: string | null
  arxiv_id?: string | null
  abstract?: string | null
  url?: string | null
}
export function searchPapersBibtex(papers: BibliographyPaper[]): string {
  return papers
    .map((paper, index) => {
      const key = `scholarseed${paper.year ?? 'nd'}${index + 1}`
      const entryType = paper.authors.length ? 'article' : 'misc'
      const fields = [
        `  title = {${bibValue(paper.title)}}`,
        paper.authors.length ? `  author = {${bibValue(paper.authors.join(' and '))}}` : '',
        paper.venue ? `  journal = {${bibValue(paper.venue)}}` : '',
        paper.year ? `  year = {${paper.year}}` : '',
        paper.doi ? `  doi = {${bibValue(paper.doi)}}` : '',
        paper.url ? `  url = {${bibValue(paper.url)}}` : '',
        paper.arxiv_id ? `  eprint = {${bibValue(paper.arxiv_id)}}` : '',
        paper.abstract ? `  abstract = {${bibValue(paper.abstract)}}` : '',
      ].filter(Boolean)
      return `@${entryType}{${key},\n${fields.join(',\n')}\n}`
    })
    .join('\n\n')
}

/**
 * AI 检索结果投影：正文列只展示 metadata.json 的 reason，摘要既不展示也不入库。
 * 在这里就把 abstract 清空，展示与 BibTeX 入库因此都拿不到摘要，
 * 文献库条目的 abstract 保持空值。
 */
export function searchResultPapers(
  papers: readonly LiteratureSearchPaper[]
): LiteratureSearchPaper[] {
  return papers.map((paper) => ({ ...paper, abstract: '' }))
}

/** Project a saved precise-search result without rerunning or reordering retrieval. */
export function conversationSearchPapers(
  papers: readonly ConversationSearchPaper[]
): LiteratureSearchPaper[] {
  return papers.map((paper) => ({
    paper_id: paper.id,
    url: paper.url,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue ?? '',
    abstract: paper.abstract ?? '',
    doi: paper.doi ?? '',
    arxiv_id: '',
    citation_count: paper.citation_count ?? null,
    tier: paper.tier ?? null,
    reason: paper.reasons.join('；'),
    subtopics_covered: [],
    access: paper.access === 'yes' ? 'open' : 'unknown',
    source: paper.sources.filter(Boolean).join('、'),
    decision: paper.decision ?? 'candidate',
    decision_reason: paper.decision_reason ?? null,
    fulltext: paper.fulltext ?? 'unknown',
  }))
}
