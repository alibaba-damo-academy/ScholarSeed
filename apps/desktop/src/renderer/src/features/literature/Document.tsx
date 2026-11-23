import React from 'react'
import { BookOpen, CircleAlert, Info, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  AlertDescription,
  Tag,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui'
import type { LiteratureReview } from '../../contracts/literature'
import { ReviewEvidenceTable, ReviewInlineCitations } from './Evidence'
import {
  REVIEW_FORMAT_LABELS,
  REVIEW_VERDICTS,
  reviewIssueSummary,
  reviewNotice,
} from './projection'

const VERDICT_TONES = {
  PASS: 'success',
  WARN: 'warning',
  FAIL: 'error',
  NOT_CHECKED: 'neutral',
  NOT_APPLICABLE: 'neutral',
} as const

export function ReviewDocument({
  review,
  openSource,
}: {
  review: LiteratureReview
  openSource: (key: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const missing = t('review.unknownCount')
  const { references, verification } = review
  const citationStyle = {
    numeric: t('review.numeric'),
    author_year: t('review.authorYear'),
    ieee: 'IEEE',
    acm: 'ACM',
    gbt7714_2025: 'GB/T 7714—2025',
  }[review.output.citation_style ?? 'numeric']
  const delivery = [
    review.output.format && REVIEW_FORMAT_LABELS[review.output.format],
    review.output.citation_style && citationStyle,
  ]
    .filter(Boolean)
    .join(' · ')
  const issues = reviewIssueSummary(review)
  const notice = reviewNotice(review)
  const metrics = [
    { count: references.cited_count, label: t('review.citedTotal'), type: 'papers' },
    { count: references.fulltext_cited_count, label: t('review.citedFulltext'), type: 'papers' },
    { count: references.abstract_cited_count, label: t('review.citedAbstract'), type: 'papers' },
    { count: verification.issue_count, label: t('review.pendingProblems'), type: 'issues' },
  ]
  return (
    <article
      data-testid="review-document"
      className="@container grid min-w-0 gap-[var(--vds-space-5)] [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-regular)] [overflow-wrap:anywhere] [&_h3]:m-0 [&_h3]:flex [&_h3]:items-center [&_h3]:gap-[var(--vds-space-2)] [&_h3]:text-[length:var(--vds-font-subhead)] [&_h3]:leading-[var(--vds-lh-subhead)] [&_h3]:font-[var(--vds-fw-medium)]"
    >
      <section className="grid min-w-0 gap-[var(--vds-space-4)]">
        <h3>
          <Info
            aria-hidden="true"
            size={16}
            className="shrink-0 text-[var(--vds-icon-outline-default)]"
          />
          {t('review.scopeDelivery')}
        </h3>
        <Card
          padding="none"
          variant="tinted"
          className="rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] px-[var(--vds-space-5)] py-[var(--vds-space-4)]"
        >
          <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-[var(--vds-space-5)] gap-y-[var(--vds-space-2)] [&_dd]:m-0 [&_dt]:text-[var(--vds-text-secondary)]">
            <dt>{t('review.researchScope')}</dt>
            <dd>{review.scope.topic || missing}</dd>
            <dt>{t('review.materialScope')}</dt>
            <dd>
              {references.cited_count === null
                ? missing
                : t('review.citedMaterials', { count: references.cited_count })}
            </dd>
            <dt>{t('review.delivery')}</dt>
            <dd>{delivery || missing}</dd>
          </dl>
        </Card>
      </section>
      {(review.section_count > 0 || review.sections.length > 0) && (
        <section className="grid min-w-0 gap-[var(--vds-space-4)]">
          <h3>
            <List
              aria-hidden="true"
              size={16}
              className="shrink-0 text-[var(--vds-icon-outline-default)]"
            />
            {t('review.structureTitle')}
          </h3>
          <Card
            padding="sm"
            variant="tinted"
            className="rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] !bg-transparent"
          >
            {review.sections.length > 0 ? (
              <ol className="m-0 list-none space-y-[var(--vds-space-2)] p-0">
                {review.sections.map((section, index) => (
                  <li key={section.id} className="grid min-w-0 gap-[var(--vds-space-2)]">
                    <p className="m-0 px-[var(--vds-space-2)] py-[var(--vds-space-1)] font-[var(--vds-fw-medium)]">
                      {index + 1}. {section.title}
                    </p>
                    {section.description && (
                      <blockquote className="m-0 rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-gray-default-transparent)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] leading-[var(--vds-literature-review-text-line-height)] text-[var(--vds-text-secondary)]">
                        <p className="m-0 border-s-2 border-[var(--vds-border-default)] ps-[var(--vds-space-3)]">
                          <ReviewInlineCitations
                            text={section.description}
                            entries={references.rows}
                            openSource={openSource}
                          />
                        </p>
                      </blockquote>
                    )}
                    <ol className="m-0 list-none space-y-[var(--vds-space-1)] ps-[var(--vds-space-5)] [&_li]:py-[var(--vds-space-2)]">
                      {section.children.map((title, childIndex) => (
                        <li key={childIndex}>
                          {index + 1}.{childIndex + 1} {title}
                        </li>
                      ))}
                    </ol>
                    {section.comparison_tables.map((title, tableIndex) => (
                      <p className="m-0" key={tableIndex}>
                        {t('review.comparisonTable')} · {title}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            ) : (
              missing
            )}
            {review.section_count > review.sections.length && (
              <p className="m-0">{t('review.moreSections')}</p>
            )}
          </Card>
        </section>
      )}
      <section className="grid min-w-0 gap-[var(--vds-space-4)]">
        <h3>
          <BookOpen
            aria-hidden="true"
            size={16}
            className="shrink-0 text-[var(--vds-icon-outline-default)]"
          />
          {t('review.referencesTitle')}
        </h3>
        <dl className="m-0 grid min-w-0 grid-cols-2 gap-[var(--vds-space-4)] @2xl:grid-cols-4">
          {metrics.map(({ count, label, type }) => {
            const text =
              count === null
                ? missing
                : t(type === 'papers' ? 'review.paperCount' : 'review.itemCount', { count })
            const number = count === null ? missing : String(count)
            const position = text.indexOf(number)
            return (
              <Card
                key={label}
                padding="none"
                variant="tinted"
                className="grid content-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-8)] border border-[var(--vds-border-default)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]"
              >
                <dt className="leading-[var(--vds-literature-review-text-line-height)] text-[var(--vds-text-secondary)]">
                  {label}
                </dt>
                <dd className="m-0 flex flex-wrap items-baseline gap-[var(--vds-space-2)]">
                  {position < 0 ? (
                    text
                  ) : (
                    <>
                      {text.slice(0, position).trim() && (
                        <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
                          {text.slice(0, position).trim()}
                        </span>
                      )}
                      <span className="text-[length:var(--vds-font-headline)] leading-[var(--vds-lh-title)] font-[var(--vds-fw-semibold)]">
                        {number}
                      </span>
                      {text.slice(position + number.length).trim() && (
                        <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
                          {text.slice(position + number.length).trim()}
                        </span>
                      )}
                    </>
                  )}
                </dd>
              </Card>
            )
          })}
        </dl>
        {references.rows.length ? (
          <ReviewEvidenceTable entries={references.rows} openSource={openSource} />
        ) : (
          <p className="m-0">{references.cited_count === 0 ? t('review.noCitations') : missing}</p>
        )}
        {references.cited_count != null && references.cited_count > references.rows.length && (
          <p className="m-0 text-[var(--vds-text-secondary)]">
            {t('review.partialReferences', {
              shown: references.rows.length,
              total: references.cited_count,
            })}
          </p>
        )}
      </section>
      <section className="grid min-w-0 gap-[var(--vds-space-4)]">
        <h3>
          <CircleAlert
            aria-hidden="true"
            size={16}
            className="shrink-0 text-[var(--vds-warning-text-primary)]"
          />
          {t('review.verificationTitle')}{' '}
          <span className="text-[var(--vds-text-secondary)]">
            {issues.total === null ? missing : t('review.issuesCount', { count: issues.total })}
          </span>
        </h3>
        {notice && (
          <Alert tone="warning">
            <AlertDescription truncate={false}>
              {notice === 'incomplete'
                ? t('review.incompleteDescription')
                : t('review.verificationPendingDescription')}
            </AlertDescription>
          </Alert>
        )}
        {verification.rows.length ? (
          <Card
            padding="none"
            variant="tinted"
            className="overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] !bg-transparent"
          >
            <Table
              aria-label={t('review.verificationTitle')}
              className="table-fixed !leading-[var(--vds-literature-review-text-line-height)] [overflow-wrap:anywhere] [&_tbody_tr:last-child]:border-b-0 [&_td]:px-[var(--vds-space-4)] [&_td]:!align-middle [&_th]:px-[var(--vds-space-4)] [&_th]:!font-[var(--vds-fw-regular)]"
            >
              <TableHeader className="bg-[var(--vds-bg-gray-default-transparent)]">
                <TableRow>
                  <TableHead className="w-1/4">{t('review.checkColumn')}</TableHead>
                  <TableHead>{t('review.issueColumn')}</TableHead>
                  <TableHead className="w-1/6">{t('review.statusColumn')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {verification.rows.map(({ check, issue }, index) => (
                  <TableRow key={index}>
                    <TableCell className="whitespace-normal align-top">
                      {check?.title || missing}
                    </TableCell>
                    <TableCell className="whitespace-normal align-top">
                      {issue ? (
                        <>
                          <p className="m-0">{issue.detail || issue.title}</p>
                          {issue.affected_content && (
                            <p className="m-0">
                              {t('review.issueAffected', { content: issue.affected_content })}
                            </p>
                          )}
                        </>
                      ) : (
                        check?.reason || missing
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal align-top">
                      {check ? (
                        <Tag
                          size="small"
                          tone={VERDICT_TONES[check.verdict]}
                          className={
                            VERDICT_TONES[check.verdict] === 'neutral'
                              ? '![--vds-tag-background:color-mix(in_srgb,var(--vds-icon-outline-default)_12%,var(--vds-bg-white-default))]'
                              : undefined
                          }
                        >
                          {t(REVIEW_VERDICTS[check.verdict])}
                        </Tag>
                      ) : (
                        missing
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <p className="m-0">{t('review.noChecks')}</p>
        )}
        {issues.total !== null && issues.hidden > 0 && (
          <p className="m-0">
            {t('review.moreIssues', {
              shown: issues.shown,
              total: issues.total,
              count: issues.hidden,
            })}
          </p>
        )}
        {review.warnings.map((warning, index) => (
          <p key={index} className="m-0">
            {warning}
          </p>
        ))}
      </section>
    </article>
  )
}
