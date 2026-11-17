import type { PluginCopyContent } from '../../../../plugins'
import type { TFunction } from 'i18next'
import {
  parseReview,
  reviewCitationTitle,
  reviewEvidenceReason,
  reviewNotice,
  reviewIssueSummary,
  reviewStatus,
  REVIEW_VERDICTS,
  REVIEW_EVIDENCE_BASIS_LABELS,
} from './projection.ts'
import { CITATIONS_ORIGIN, RESULT_LABELS, searchCriteria, searchWarningKeys } from './result.ts'

const CHOICE_SLOTS = new Set([
  'interaction.question',
  'literature.authorization',
  'literature.selection',
])
const PAPER_SLOTS = new Set(['display.literature-search', 'preview.literature-results'])

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : []
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function literatureCopy(
  slot: string,
  data: Record<string, unknown>,
  translate: TFunction<'literature'>
): PluginCopyContent | null {
  if (slot === 'display.literature-review') return reviewCopy(data, translate)
  if (slot === 'literature.outline') {
    const review = reviewCopy(data, translate)
    const choices = literatureCopy('interaction.question', data, translate)
    return { text: [review.text, choices?.text].filter(Boolean).join('\n\n') }
  }
  let lines: string[] = []
  if (CHOICE_SLOTS.has(slot)) {
    const answers = new Set(strings(data.answers))
    const selected = new Set(strings(data.selected_paper_ids))
    lines = [
      text(data.displayQuestion ?? data.question),
      ...records(data.options).map((option) =>
        [
          answers.has(text(option.label)) ? '[x]' : '[ ]',
          text(option.displayLabel ?? option.label),
          text(option.displayDescription ?? option.description),
        ]
          .filter(Boolean)
          .join(' ')
      ),
      ...records(data.papers).map((paper) =>
        [
          slot === 'literature.selection' ? (selected.has(text(paper.id)) ? '[x]' : '[ ]') : '',
          text(paper.label),
          text(paper.description),
        ]
          .filter(Boolean)
          .join(' ')
      ),
    ]
  } else if (PAPER_SLOTS.has(slot)) {
    const papers = records(data.papers)
    const context = data.context as { authorization?: { status?: unknown } } | undefined
    const headings: string[] = []
    const resultStatus = text(data.status) as keyof typeof RESULT_LABELS
    if (
      (slot === 'display.literature-search' || slot === 'preview.literature-results') &&
      Object.prototype.hasOwnProperty.call(RESULT_LABELS, resultStatus)
    ) {
      headings.push(
        translate('result.heading', {
          heading:
            data.origin === CITATIONS_ORIGIN
              ? translate('result.citations')
              : context?.authorization?.status === 'pending'
                ? translate('searchResult.authorizationPending')
                : translate(RESULT_LABELS[resultStatus]),
          count: typeof data.retained === 'number' ? data.retained : papers.length,
        })
      )
    }
    lines = [
      ...headings,
      headings.includes(text(data.title)) ? '' : text(data.title),
      text(data.status),
      text(data.state),
      ...searchCriteria(data, translate),
      ...strings(data.warnings),
      ...searchWarningKeys(strings(data.warnings)).map((key) => translate(key)),
      ...papers.map((paper) =>
        [
          ...new Set(
            [
              text(paper.title),
              strings(paper.authors).join(', '),
              typeof paper.year === 'number' ? String(paper.year) : '',
              text(paper.venue),
              text(paper.url),
              text(paper.doi) && text(paper.url) !== `https://doi.org/${text(paper.doi)}`
                ? `https://doi.org/${text(paper.doi)}`
                : '',
              text(paper.arxiv_id) ? `https://arxiv.org/abs/${text(paper.arxiv_id)}` : '',
              text(paper.abstract),
              text(paper.claim),
              text(paper.evidence),
              text(paper.reason),
              text(paper.decision_reason),
              ...strings(paper.reasons),
              text(paper.resource_path),
              text(paper.error),
              text(paper.library_error),
              ...[paper.saved, paper.library, paper.fulltext, paper.verification]
                .filter((value) => typeof value === 'string')
                .map((value) => `[${value}]`),
            ].filter(Boolean)
          ),
        ].join('\n')
      ),
      ...records(data.failures).map((failure) =>
        [text(failure.title) || text(failure.paper_id), text(failure.code), text(failure.reason)]
          .filter(Boolean)
          .join(': ')
      ),
    ]
  }
  const content = lines.filter(Boolean).join('\n\n')
  return content ? { text: content } : null
}

export function reviewCopy(
  data: Record<string, unknown>,
  translate: TFunction<'literature'>
): PluginCopyContent {
  const review = parseReview(data)
  if (!review) return { text: translate('review.unreadable') }
  const count = (value: number | null): string =>
    value === null ? translate('review.unknownCount') : String(value)
  const notice = reviewNotice(review)
  const issues = reviewIssueSummary(review)
  const lines = [
    review.title,
    reviewStatus(review, translate),
    `${translate('review.researchScope')} ${review.scope.topic || count(null)}`,
    `${translate('review.delivery')}${review.output.format ?? count(null)} · ${review.output.citation_style ?? count(null)}`,
    ...(
      [
        [review.references.cited_count, 'review.citedTotal'],
        [review.references.fulltext_cited_count, 'review.citedFulltext'],
        [review.references.abstract_cited_count, 'review.citedAbstract'],
        [review.verification.issue_count, 'review.pendingProblems'],
      ] as const
    ).map(([value, label]) => `${translate(label)}: ${count(value)}`),
    ...(notice === 'incomplete'
      ? [translate('review.incompleteTitle'), translate('review.incompleteDescription')]
      : notice === 'verification'
        ? [
            translate('review.verificationPendingTitle'),
            translate('review.verificationPendingDescription'),
          ]
        : []),
    ...review.warnings,
    translate('review.structureTitle'),
    ...review.sections.map((section) =>
      [
        `${section.id} ${section.title}`,
        section.papers ? translate('review.paperCount', { count: section.papers }) : '',
        section.description || translate('review.outlineDetails'),
        ...section.children,
        ...section.comparison_tables.map(
          (title) => `${translate('review.comparisonTable')}: ${title}`
        ),
      ]
        .filter(Boolean)
        .join('\n')
    ),
    review.section_count > review.sections.length ? translate('review.moreSections') : '',
    translate('review.referencesTitle'),
    ...review.references.rows.map(({ citation, evidence, target }) =>
      [
        reviewCitationTitle(citation),
        [citation.authors, citation.year, citation.venue].filter(Boolean).join(' · '),
        target?.kind === 'web' ? target.url : '',
        evidence ? translate(REVIEW_EVIDENCE_BASIS_LABELS[evidence.basis]) : count(null),
        evidence ? reviewEvidenceReason(evidence, translate) : '',
        evidence?.extracted_chars == null
          ? ''
          : translate('review.extractedCharacters', { count: evidence.extracted_chars }),
      ]
        .filter(Boolean)
        .join('\n')
    ),
    translate('review.verificationTitle'),
    ...review.verification.rows.map(({ check, issue }) =>
      [
        check && [check.title, translate(REVIEW_VERDICTS[check.verdict]), check.reason].join(' · '),
        issue && (issue.detail || issue.title),
        issue?.paper_ids.length
          ? translate('review.issuePapers', { papers: issue.paper_ids.join('、') })
          : '',
        issue?.affected_content
          ? translate('review.issueAffected', { content: issue.affected_content })
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    issues.total !== null && issues.hidden > 0
      ? translate('review.moreIssues', {
          shown: issues.shown,
          total: issues.total,
          count: issues.hidden,
        })
      : '',
    ...review.artifacts.map((artifact) =>
      [artifact.title, artifact.path].filter(Boolean).join('\n')
    ),
  ]
  return { text: lines.filter(Boolean).join('\n\n') }
}
