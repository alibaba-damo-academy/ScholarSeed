import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, Link } from 'lucide-react'

import {
  Tag,
  Button,
  Card,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
} from '../../components/ui'
import type { ReviewReference } from '../../contracts/literature'
import { reviewCitationTitle, reviewEvidenceReason } from './projection'

export function ReviewEvidenceTable({
  entries,
  openSource,
}: {
  entries: ReviewReference[]
  openSource: (key: string) => Promise<void>
}): ReactElement {
  const { t } = useTranslation('literature')
  const { toast } = useToast()
  return (
    <Card
      padding="none"
      variant="tinted"
      className="overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] !bg-transparent"
    >
      <Table
        aria-label={t('review.referencesTitle')}
        className="table-fixed !leading-[var(--vds-literature-review-text-line-height)] [overflow-wrap:anywhere] [&_tbody_tr:last-child]:border-b-0 [&_td]:px-[var(--vds-space-4)] [&_td]:!align-middle [&_th]:px-[var(--vds-space-4)] [&_th]:!font-[var(--vds-fw-regular)]"
      >
        <TableHeader className="bg-[var(--vds-bg-gray-default-transparent)]">
          <TableRow>
            <TableHead className="w-2/3 @2xl:w-3/4">{t('review.referencePaper')}</TableHead>
            <TableHead className="w-1/3 @2xl:w-1/4">{t('review.referenceBasis')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(({ citation, citation_key, evidence, target }) => {
            const title = reviewCitationTitle(citation)
            const reason = evidence && reviewEvidenceReason(evidence, t)
            const extracted =
              evidence?.extracted_chars == null
                ? null
                : t('review.extractedCharacters', { count: evidence.extracted_chars })
            return (
              <TableRow key={citation_key}>
                <TableCell className="overflow-hidden align-top">
                  {target ? (
                    <Button
                      unstyled
                      className="inline-flex w-full min-w-0 items-center gap-[var(--vds-space-2)] text-left hover:underline focus-visible:[box-shadow:var(--vds-focus-brand)]"
                      title={title}
                      onClick={() =>
                        void openSource(citation_key).catch(() =>
                          toast({ title: t('review.referenceOpenFailed'), tone: 'error' })
                        )
                      }
                    >
                      <Link
                        aria-hidden="true"
                        size={14}
                        className="shrink-0 text-[var(--vds-text-secondary)]"
                      />
                      <span className="min-w-0 truncate">{title}</span>
                    </Button>
                  ) : (
                    <span className="block truncate" title={title}>
                      {title}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal align-top">
                  <div className="flex flex-wrap items-center gap-[var(--vds-space-1)]">
                    {evidence?.basis === 'fulltext' ? (
                      <Tag size="small" tone="success">
                        {t('review.fulltextReference')}
                      </Tag>
                    ) : evidence?.basis === 'abstract' ? (
                      <Tag
                        size="small"
                        tone="neutral"
                        className="![--vds-tag-background:color-mix(in_srgb,var(--vds-icon-outline-default)_12%,var(--vds-bg-white-default))]"
                      >
                        {t('review.abstractReference')}
                      </Tag>
                    ) : (
                      t('review.unknownCount')
                    )}
                    {evidence && (reason || extracted || evidence.basis !== 'fulltext') && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <IconButton
                            label={t('review.referenceDetails')}
                            title={undefined}
                            icon={
                              <TriangleAlert
                                size={14}
                                className="text-[var(--vds-warning-text-primary)]"
                              />
                            }
                            size="xs"
                            variant="ghostIcon"
                          />
                        </TooltipTrigger>
                        <TooltipContent className="border border-[var(--vds-warning-light-border)] !bg-[var(--vds-warning-light-bg-default)] !text-[var(--vds-warning-text-primary)]">
                          {[reason, extracted, t('review.evidenceCaveat')]
                            .filter(Boolean)
                            .join(' · ')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
