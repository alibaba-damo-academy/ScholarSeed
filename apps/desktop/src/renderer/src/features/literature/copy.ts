import type { PluginCopyContent } from '../../../../plugins'
import type { TFunction } from 'i18next'
import { parseReview, reviewNotice, reviewStatus, REVIEW_VERDICTS } from './projection.ts'
import { downloadOutcome, parseDownloadCard } from './admission.ts'
import { RESULT_LABELS, searchCriteria, searchWarningKeys } from './result.ts'
import { DELIVERY_STATUS_KEYS } from './utils.ts'

const CHOICE_SLOTS = new Set([
  'interaction.question',
  'literature.authorization',
  'literature.selection',
])
const PAPER_SLOTS = new Set([
  'display.literature-search',
  'preview.literature-results',
  'display.literature-references',
  'display.literature-downloads',
  'display.literature-delivery',
])

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
    const papers = records(data.references ?? data.papers)
    const headings: string[] = []
    const resultStatus = text(data.status) as keyof typeof RESULT_LABELS
    if (
      (slot === 'display.literature-search' || slot === 'preview.literature-results') &&
      Object.prototype.hasOwnProperty.call(RESULT_LABELS, resultStatus)
    ) {
      headings.push(
        translate('result.heading', {
          heading:
            data.selection &&
            typeof data.selection === 'object' &&
            'artifact_id' in data.selection &&
            data.selection.artifact_id
              ? translate('searchResult.authorizationPending')
              : translate(RESULT_LABELS[resultStatus]),
          count: typeof data.retained === 'number' ? data.retained : papers.length,
        })
      )
    }
    if (slot === 'display.literature-references')
      headings.push(translate('references.heading', { count: papers.length }))
    if (slot === 'display.literature-downloads') {
      const card = parseDownloadCard(data)
      if (card) {
        const outcome = downloadOutcome(card)
        headings.push(
          translate(outcome.heading, { count: outcome.saved, failed: outcome.failed }),
          translate(outcome.descriptionKey)
        )
      }
    }
    if (slot === 'display.literature-delivery') {
      const status = text(data.state) as keyof typeof DELIVERY_STATUS_KEYS
      const reused = papers.filter((paper) => paper.save_reused || paper.library_reused).length
      const skipped = papers.filter((paper) => paper.saved === 'skipped').length
      const librarySkipped = papers.filter(
        (paper) => paper.saved === 'saved' && paper.library === 'skipped'
      ).length
      headings.push(
        translate('delivery.cardTitle'),
        translate('delivery.counts', {
          acquired: papers.length,
          saved: papers.filter((paper) => paper.saved === 'saved').length,
          admitted: papers.filter((paper) => paper.library === 'saved').length,
        })
      )
      if (Object.prototype.hasOwnProperty.call(DELIVERY_STATUS_KEYS, status))
        headings.push(
          translate(
            status === 'saved' && skipped === papers.length
              ? 'delivery.allSkipped'
              : DELIVERY_STATUS_KEYS[status]
          )
        )
      if (reused) headings.push(translate('delivery.reused', { count: reused }))
      if (skipped) headings.push(translate('delivery.skipped', { count: skipped }))
      if (librarySkipped)
        headings.push(translate('delivery.librarySkipped', { count: librarySkipped }))
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
  const issueCount = review.issue_count ?? review.issues.length
  const lines = [
    review.title,
    reviewStatus(review, translate),
    review.scope.topic || review.intent,
    `${translate('review.timeRange')}${review.scope.time_range}`,
    `${translate('review.focus')}${review.scope.focus.join('；') || translate('review.defaultFocus')}`,
    `${translate('review.materialScope')}${translate('review.materialCounts', {
      project: count(review.scope.project_materials),
      external: count(review.scope.external_materials),
    })}`,
    ...(review.scope.requested_materials.length
      ? [`${translate('review.requestedMaterials')}${review.scope.requested_materials.join('；')}`]
      : []),
    `${translate('review.delivery')}${review.output.format ?? translate('review.pendingSelection')} · ${review.output.citation_style ?? translate('review.pendingSelection')}`,
    review.output.decided_by === 'default' ? translate('review.defaultSettings') : '',
    ...[review.included, review.fulltext, review.abstract_only, review.pending_checks].map(
      (value, index) =>
        `${translate((['review.included', 'review.fulltext', 'review.abstractOnly', 'review.pendingChecks'] as const)[index])}: ${count(value)}`
    ),
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
    ...(review.checkpoint === 'result'
      ? [
          translate('review.citationsTitle'),
          ...review.citations.map((citation, index) =>
            [`${index + 1}. ${citation.title}`, citation.authors, citation.year, citation.venue]
              .filter(Boolean)
              .join(' · ')
          ),
          review.citations.length ? '' : translate('review.noCitations'),
        ]
      : []),
    ...review.abstract_evidence.flatMap((evidence) => [
      translate('review.abstractEvidenceTitle'),
      evidence.title || evidence.paper_id,
      evidence.reason,
    ]),
    translate('review.verificationTitle'),
    ...review.checks.map((check) =>
      [check.title, translate(REVIEW_VERDICTS[check.verdict]), check.reason].join('\n')
    ),
    review.checks.length ? '' : translate('review.noChecks'),
    ...review.issues.map((issue) =>
      [
        issue.title,
        issue.detail,
        issue.paper_ids.length
          ? translate('review.issuePapers', { papers: issue.paper_ids.join('、') })
          : '',
        issue.affected_content
          ? translate('review.issueAffected', { content: issue.affected_content })
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    issueCount > review.issues.length
      ? translate('review.moreIssues', {
          shown: review.issues.length,
          total: issueCount,
          count: issueCount - review.issues.length,
        })
      : '',
    ...review.artifacts.map((artifact) =>
      [artifact.title, artifact.path].filter(Boolean).join('\n')
    ),
  ]
  return { text: lines.filter(Boolean).join('\n\n') }
}
