import React from 'react'
import { useTranslation } from 'react-i18next'

import { openByDefault } from '../../fileOpen'
import { activeThread, useApp } from '../../store'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui'
import type { ReviewArtifact } from '../../contracts/literature'
import { parseReview, reviewStatus, REVIEW_VERDICTS } from './projection'

export function LiteratureReviewCard({ content }: { content: Record<string, unknown> }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const review = parseReview(content)
  if (!review) return <Alert tone="warning"><AlertDescription>{t('review.unreadable')}</AlertDescription></Alert>
  const countLabel = (count: number | null): string => count === null ? t('review.unknownCount') : String(count)
  const formatLabel = (format: string | null): string => format === 'latex_pdf' ? 'PDF' : format === 'markdown' ? 'Markdown' : t('review.pendingSelection')
  const citationLabel = (style: string | null): string => ({ numeric: t('review.numeric'), author_year: t('review.authorYear'), ieee: 'IEEE', acm: 'ACM' }[style ?? ''] ?? t('review.pendingSelection'))
  const problemCount = review.checks.length ? review.checks.filter(check => check.verdict === 'WARN' || check.verdict === 'FAIL' || check.verdict === 'NOT_CHECKED').length : null
  const complete = review.status === 'generated' && review.checks.length > 0
    && !review.checks.some(check => check.verdict === 'FAIL' || check.verdict === 'NOT_CHECKED')
  const openArtifact = (artifact: ReviewArtifact): void => {
    const absolute = thread.workdir ? `${thread.workdir.replace(/\/$/, '')}/${artifact.path.replace(/^\//, '')}` : artifact.path
    void openByDefault({ relative: artifact.path, absolute, title: artifact.title }, {
      openPreview: target => act.openFilePreview({ ...target, absolutePath: absolute, sessionId: review.session_id, artifactId: artifact.artifact_id, mediaType: artifact.media_type, size: artifact.size }),
      onFailed: (_context, note) => act.openFilePreview({ path: artifact.path, absolutePath: absolute, sessionId: review.session_id, artifactId: artifact.artifact_id, title: artifact.title, mediaType: artifact.media_type, size: artifact.size, content: note })
    })
  }
  const body = review.artifacts.find(artifact => /06_output\/survey\.(md|pdf)$/.test(artifact.path))
  const tableCount = review.sections.reduce((count, section) => count + section.comparison_tables.length, 0)
  return <section data-testid="literature-review-card" className="grid min-w-0 gap-[var(--vds-space-3)]">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]"><Badge>{t('review.badge')}</Badge><span className="text-xs text-[var(--vds-text-secondary)]">{reviewStatus(review, t)}</span>{review.output.decided_by === 'default' ? <Badge tone="warning">{t('review.defaultSettings')}</Badge> : null}</div>
        <CardTitle>{review.title}</CardTitle>
        <CardDescription>{review.scope.topic || review.intent}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]">
        <p className="m-0"><strong className="text-[var(--vds-text-primary)]">{t('review.timeRange')}</strong>{review.scope.time_range}</p>
        <p className="m-0"><strong className="text-[var(--vds-text-primary)]">{t('review.focus')}</strong>{review.scope.focus.length ? review.scope.focus.join('；') : t('review.defaultFocus')}</p>
        <p className="m-0"><strong className="text-[var(--vds-text-primary)]">{t('review.materialScope')}</strong>{t('review.materialCounts', { project: countLabel(review.scope.project_materials), external: countLabel(review.scope.external_materials) })}</p>
        {review.scope.requested_materials.length ? <p className="m-0"><strong className="text-[var(--vds-text-primary)]">{t('review.requestedMaterials')}</strong>{review.scope.requested_materials.join('；')}</p> : null}
        <p className="m-0"><strong className="text-[var(--vds-text-primary)]">{t('review.delivery')}</strong>{formatLabel(review.output.format)} · {citationLabel(review.output.citation_style)}</p>
      </CardContent>
    </Card>
    {!complete && review.checkpoint === 'result' ? <Alert tone="warning" title={t('review.incompleteTitle')} description={t('review.incompleteDescription')} /> : null}
    {review.warnings.length > 0 && <Alert tone="warning"><div className="grid gap-[var(--vds-space-1)]">{review.warnings.map((warning, index) => <AlertDescription key={index} truncate={false}>{warning}</AlertDescription>)}</div></Alert>}
    <div className="grid grid-cols-2 gap-[var(--vds-space-2)] md:grid-cols-4">
      {[[review.included, t('review.included')], [review.fulltext, t('review.fulltext')], [review.abstract_only, t('review.abstractOnly')], [review.pending_checks, t('review.pendingChecks')]].map(([value, label]) => <Card key={String(label)} padding="sm"><p className="m-0 text-lg font-semibold">{countLabel(value as number | null)}</p><p className="mb-0 text-xs text-[var(--vds-text-secondary)]">{label}</p></Card>)}
    </div>
    {review.sections.length > 0 && <Card>
      <CardHeader><CardTitle>{t('review.structureTitle')}</CardTitle><CardDescription>{t('review.structureDescription', { count: review.section_count })}{tableCount ? t('review.tableCount', { count: tableCount }) : ''}</CardDescription></CardHeader>
      <CardContent><Accordion mode="multiple">
        {review.sections.map(section => <AccordionItem key={section.id} value={section.id}>
          <AccordionTrigger className="gap-[var(--vds-space-2)] after:shrink-0"><span className="flex min-w-0 flex-1 items-start gap-[var(--vds-space-2)]"><span className="text-[var(--vds-text-tertiary)]">{section.id}</span><span className="min-w-0 flex-1 break-words">{section.title}</span><span className="shrink-0 text-xs text-[var(--vds-text-secondary)]">{section.papers > 0 ? t('review.paperCount', { count: section.papers }) : ''}</span></span></AccordionTrigger>
          <AccordionContent><div className="text-sm text-[var(--vds-text-secondary)]"><p>{section.description || t('review.outlineDetails')}</p>{section.children.map((title, index) => <p key={index}>{title}</p>)}{section.comparison_tables.map((title, index) => <p key={`table-${index}`}><Badge size="sm">{t('review.comparisonTable')}</Badge> {title}</p>)}</div></AccordionContent>
        </AccordionItem>)}
      </Accordion>{review.section_count > review.sections.length && <p className="text-xs text-[var(--vds-text-secondary)]">{t('review.moreSections')}</p>}</CardContent>
    </Card>}
    {body ? <Card padding="sm"><div className="flex items-center justify-between gap-[var(--vds-space-3)]"><div><strong>{t('review.bodyTitle')}</strong><p className="m-0 text-xs text-[var(--vds-text-secondary)]">{body.title}</p></div><Button variant="secondary" onClick={() => openArtifact(body)}>{t('review.openBody')}</Button></div></Card> : null}
    {review.checkpoint === 'result' ? <Card>
      <CardHeader><CardTitle>{t('review.citationsTitle')}</CardTitle><CardDescription>{review.citations.length ? t('review.citationCount', { count: review.citations.length }) : t('review.citationsUnavailable')}</CardDescription></CardHeader>
      <CardContent><Collapsible defaultOpen={review.citations.length > 0}><CollapsibleTrigger>{t('review.viewCitations')}</CollapsibleTrigger><CollapsibleContent><div className="grid gap-[var(--vds-space-2)]">{review.citations.map((citation, index) => <p className="m-0 text-sm" key={`${citation.title}:${index}`}>{index + 1}. {citation.title}{citation.authors ? ` · ${citation.authors}` : ''}{citation.year ? ` · ${citation.year}` : ''}</p>)}{!review.citations.length ? <p className="text-sm text-[var(--vds-text-secondary)]">{t('review.noCitations')}</p> : null}</div></CollapsibleContent></Collapsible></CardContent>
    </Card> : null}
    {review.abstract_evidence.length ? <Card>
      <CardHeader><CardTitle>{t('review.abstractEvidenceTitle')}</CardTitle><CardDescription>{t('review.abstractEvidenceDescription')}</CardDescription></CardHeader>
      <CardContent><div className="grid gap-[var(--vds-space-2)]">{review.abstract_evidence.map(evidence => <div key={evidence.paper_id}><p className="m-0 text-sm font-medium">{evidence.title || evidence.paper_id}</p><p className="m-0 text-xs text-[var(--vds-text-secondary)]">{evidence.reason}</p></div>)}</div></CardContent>
    </Card> : null}
    <Card>
      <CardHeader><CardTitle>{t('review.verificationTitle')}</CardTitle><CardDescription>{review.checks.length ? t('review.verificationCount', { count: problemCount ?? 0 }) : t('review.noVerification')}</CardDescription></CardHeader>
      <CardContent className="grid gap-[var(--vds-space-3)]">
        <Collapsible><CollapsibleTrigger>{t('review.viewVerification')}</CollapsibleTrigger><CollapsibleContent>{review.checks.map((check, index) => <div key={index} className="py-[var(--vds-space-2)]"><div className="flex items-start justify-between gap-[var(--vds-space-2)]"><span>{check.title}</span><span className="shrink-0 text-xs text-[var(--vds-text-secondary)]">{t(REVIEW_VERDICTS[check.verdict])}</span></div><p className="mb-0 break-words text-xs text-[var(--vds-text-secondary)]">{check.reason}</p></div>)}{!review.checks.length && <p>{t('review.noChecks')}</p>}</CollapsibleContent></Collapsible>
        {review.issues.length ? <Collapsible defaultOpen><CollapsibleTrigger>{t('review.issuesCount', { count: review.issues.length })}</CollapsibleTrigger><CollapsibleContent>{review.issues.map((issue, index) => <Alert key={index} tone="warning" title={issue.title} description={[issue.detail, issue.paper_ids.length ? t('review.issuePapers', { papers: issue.paper_ids.join('、') }) : '', issue.affected_content ? t('review.issueAffected', { content: issue.affected_content }) : ''].filter(Boolean).join('；')} />)}</CollapsibleContent></Collapsible> : null}
      </CardContent>
    </Card>
  </section>
}
