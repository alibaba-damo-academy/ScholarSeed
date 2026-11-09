import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import type { LiteratureCardPorts } from './ports'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui'
import type { ReviewArtifact } from '../../contracts/literature'
import {
  parseReview,
  reviewNotice,
  reviewIssueSummary,
  reviewStatus,
  reviewEvidenceReason,
  REVIEW_VERDICTS,
} from './projection'

function ReviewCollapsibleTrigger({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <CollapsibleTrigger className="group w-full !justify-start gap-[var(--vds-space-2)] !rounded-none !border-0 !bg-transparent ![padding:var(--vds-space-3)_var(--vds-space-4)] hover:![background:var(--vds-other-overlay-1)]">
      <span className="shrink-0 transition-transform group-data-[state=open]:rotate-180">
        <Icon name="chevron-down" size={13} sw={1.8} />
      </span>
      <span>{children}</span>
    </CollapsibleTrigger>
  )
}

function ReviewCollapsible({
  children,
  defaultOpen = false,
  label,
}: {
  children: React.ReactNode
  defaultOpen?: boolean
  label: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible
      className="!gap-0 overflow-hidden rounded-[var(--vds-accordion-radius)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
      defaultOpen={defaultOpen}
    >
      <ReviewCollapsibleTrigger>{label}</ReviewCollapsibleTrigger>
      <CollapsibleContent className="!rounded-none !border-x-0 !border-b-0 !bg-transparent ![padding:var(--vds-space-3)_var(--vds-space-4)]">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function LiteratureReviewCard({
  content,
  ports,
}: {
  ports: LiteratureCardPorts
  content: Record<string, unknown>
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const review = parseReview(content)
  if (!review)
    return (
      <Alert tone="warning">
        <AlertDescription>{t('review.unreadable')}</AlertDescription>
      </Alert>
    )
  const countLabel = (count: number | null): string =>
    count === null ? t('review.unknownCount') : String(count)
  const formatLabel = (format: string | null): string =>
    format === 'latex_pdf'
      ? 'PDF'
      : format === 'markdown'
        ? 'Markdown'
        : t('review.pendingSelection')
  const citationLabel = (style: string | null): string =>
    ({
      numeric: t('review.numeric'),
      author_year: t('review.authorYear'),
      ieee: 'IEEE',
      acm: 'ACM',
      gbt7714_2025: 'GB/T 7714—2025',
    })[style ?? ''] ?? t('review.pendingSelection')
  const problemCount = review.checks.length
    ? review.checks.filter(
        (check) =>
          check.verdict === 'WARN' || check.verdict === 'FAIL' || check.verdict === 'NOT_CHECKED'
      ).length
    : null
  const notice = reviewNotice(review)
  const issueSummary = reviewIssueSummary(review)
  const openArtifact = (artifact: ReviewArtifact): void => {
    void ports.openArtifact(artifact.artifact_id)
  }
  const body = review.artifacts.find((artifact) =>
    /06_output\/survey\.(md|pdf)$/.test(artifact.path)
  )
  const tableCount = review.sections.reduce(
    (count, section) => count + section.comparison_tables.length,
    0
  )
  return (
    <section data-testid="literature-review-card" className="grid min-w-0 gap-[var(--vds-space-3)]">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
            <Badge>{t('review.badge')}</Badge>
            <span className="text-xs text-[var(--vds-text-secondary)]">
              {reviewStatus(review, t)}
            </span>
            {review.output.decided_by === 'default' ? (
              <Badge tone="warning">{t('review.defaultSettings')}</Badge>
            ) : null}
          </div>
          <CardTitle>{review.title}</CardTitle>
          <CardDescription>{review.scope.topic || review.intent}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]">
          <p className="m-0">
            <strong className="text-[var(--vds-text-primary)]">{t('review.timeRange')}</strong>
            {review.scope.time_range}
          </p>
          <p className="m-0">
            <strong className="text-[var(--vds-text-primary)]">{t('review.focus')}</strong>
            {review.scope.focus.length ? review.scope.focus.join('；') : t('review.defaultFocus')}
          </p>
          <p className="m-0">
            <strong className="text-[var(--vds-text-primary)]">{t('review.materialScope')}</strong>
            {t('review.materialCounts', {
              project: countLabel(review.scope.project_materials),
              external: countLabel(review.scope.external_materials),
            })}
          </p>
          {review.scope.requested_materials.length ? (
            <p className="m-0">
              <strong className="text-[var(--vds-text-primary)]">
                {t('review.requestedMaterials')}
              </strong>
              {review.scope.requested_materials.join('；')}
            </p>
          ) : null}
          <p className="m-0">
            <strong className="text-[var(--vds-text-primary)]">{t('review.delivery')}</strong>
            {formatLabel(review.output.format)} · {citationLabel(review.output.citation_style)}
          </p>
        </CardContent>
      </Card>
      {notice ? (
        <Alert
          tone="warning"
          title={
            notice === 'incomplete'
              ? t('review.incompleteTitle')
              : t('review.verificationPendingTitle')
          }
          description={
            notice === 'incomplete'
              ? t('review.incompleteDescription')
              : t('review.verificationPendingDescription')
          }
        />
      ) : null}
      {review.warnings.length > 0 && (
        <Alert tone="warning">
          <div className="grid gap-[var(--vds-space-1)]">
            {review.warnings.map((warning, index) => (
              <AlertDescription key={index} truncate={false}>
                {warning}
              </AlertDescription>
            ))}
          </div>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-[var(--vds-space-2)] md:grid-cols-4">
        {[
          [review.included, t('review.included')],
          [review.fulltext, t('review.fulltext')],
          [review.abstract_only, t('review.abstractOnly')],
          [review.pending_checks, t('review.pendingChecks')],
        ].map(([value, label]) => (
          <Card key={String(label)} padding="sm">
            <p className="m-0 text-lg font-semibold">{countLabel(value as number | null)}</p>
            <p className="mb-0 text-xs text-[var(--vds-text-secondary)]">{label}</p>
          </Card>
        ))}
      </div>
      {review.sections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('review.structureTitle')}</CardTitle>
            <CardDescription>
              {t('review.structureDescription', { count: review.section_count })}
              {tableCount ? t('review.tableCount', { count: tableCount }) : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion mode="multiple">
              {review.sections.map((section) => (
                <AccordionItem key={section.id} value={section.id}>
                  <AccordionTrigger className="gap-[var(--vds-space-2)]">
                    <span className="flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)]">
                      <span className="text-[var(--vds-text-tertiary)]">{section.id}</span>
                      <span className="min-w-0 flex-1 break-words">{section.title}</span>
                      <span className="shrink-0 text-xs text-[var(--vds-text-secondary)]">
                        {section.papers > 0
                          ? t('review.paperCount', { count: section.papers })
                          : ''}
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]">
                      <p>{section.description || t('review.outlineDetails')}</p>
                      {section.children.map((title, index) => (
                        <p key={index}>{title}</p>
                      ))}
                      {section.comparison_tables.map((title, index) => (
                        <p key={`table-${index}`}>
                          <Badge size="sm">{t('review.comparisonTable')}</Badge> {title}
                        </p>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
            {review.section_count > review.sections.length && (
              <p className="text-xs text-[var(--vds-text-secondary)]">{t('review.moreSections')}</p>
            )}
          </CardContent>
        </Card>
      )}
      {body ? (
        <Card padding="sm">
          <div className="flex items-center justify-between gap-[var(--vds-space-3)]">
            <div>
              <strong>{t('review.bodyTitle')}</strong>
              <p className="m-0 text-xs text-[var(--vds-text-secondary)]">{body.title}</p>
            </div>
            <Button variant="secondary" onClick={() => openArtifact(body)}>
              {t('review.openBody')}
            </Button>
          </div>
        </Card>
      ) : null}
      {review.checkpoint === 'result' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('review.citationsTitle')}</CardTitle>
            <CardDescription>
              {review.citations.length
                ? t('review.citationCount', { count: review.citations.length })
                : t('review.citationsUnavailable')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReviewCollapsible
              defaultOpen={review.citations.length > 0}
              label={t('review.viewCitations')}
            >
              <div className="grid gap-[var(--vds-space-2)]">
                {review.citations.map((citation, index) => (
                  <p
                    className="m-0 text-[length:var(--vds-font-body-lv2)]"
                    key={`${citation.title}:${index}`}
                  >
                    {index + 1}. {citation.title}
                    {citation.authors ? ` · ${citation.authors}` : ''}
                    {citation.year ? ` · ${citation.year}` : ''}
                  </p>
                ))}
                {!review.citations.length ? (
                  <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                    {t('review.noCitations')}
                  </p>
                ) : null}
              </div>
            </ReviewCollapsible>
          </CardContent>
        </Card>
      ) : null}
      {review.abstract_evidence.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('review.abstractEvidenceTitle')}</CardTitle>
            <CardDescription>{t('review.abstractEvidenceDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-[var(--vds-space-2)]">
              {review.abstract_evidence.map((evidence) => (
                <div key={evidence.paper_id}>
                  <p className="m-0 text-sm font-medium">{evidence.title || evidence.paper_id}</p>
                  <p className="m-0 text-xs text-[var(--vds-text-secondary)]">
                    {reviewEvidenceReason(evidence, t)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('review.verificationTitle')}</CardTitle>
          <CardDescription>
            {review.checks.length
              ? t('review.verificationCount', { count: problemCount ?? 0 })
              : t('review.noVerification')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-[var(--vds-space-3)]">
          <ReviewCollapsible label={t('review.viewVerification')}>
            {review.checks.map((check, index) => (
              <div key={index} className="py-[var(--vds-space-1)]">
                <div className="flex items-start justify-between gap-[var(--vds-space-2)]">
                  <span>{check.title}</span>
                  <span className="shrink-0 text-xs text-[var(--vds-text-secondary)]">
                    {t(REVIEW_VERDICTS[check.verdict])}
                  </span>
                </div>
                <p className="mb-0 break-words text-xs text-[var(--vds-text-secondary)]">
                  {check.reason}
                </p>
              </div>
            ))}
            {!review.checks.length && <p>{t('review.noChecks')}</p>}
          </ReviewCollapsible>
          {issueSummary.total ? (
            <ReviewCollapsible
              defaultOpen
              label={t('review.issuesCount', { count: issueSummary.total })}
            >
              {review.issues.map((issue, index) => (
                <Alert key={index} tone="warning">
                  <AlertTitle>{issue.title}</AlertTitle>
                  <AlertDescription truncate={false}>
                    {[
                      issue.detail,
                      issue.paper_ids.length
                        ? t('review.issuePapers', { papers: issue.paper_ids.join('、') })
                        : '',
                      issue.affected_content
                        ? t('review.issueAffected', { content: issue.affected_content })
                        : '',
                    ]
                      .filter(Boolean)
                      .join('；')}
                  </AlertDescription>
                </Alert>
              ))}
              {issueSummary.hidden > 0 ? (
                <p className="text-[length:var(--vds-type-caption-size)] leading-[var(--vds-type-caption-line)] text-[var(--vds-text-secondary)]">
                  {t('review.moreIssues', {
                    shown: review.issues.length,
                    total: issueSummary.total,
                    count: issueSummary.hidden,
                  })}
                </p>
              ) : null}
            </ReviewCollapsible>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}
