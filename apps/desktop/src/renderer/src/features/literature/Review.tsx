import React from 'react'
import { BookOpenCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, Button } from '../../components/ui'
import { ReviewDocument } from './Document'
import type { LiteratureCardPorts } from './ports'
import { parseReview } from './projection'
import { LiteratureResultReceipt } from './Summary'

export function LiteratureReviewCard({
  content,
  ports,
  detail = false,
}: {
  ports: LiteratureCardPorts
  content: Record<string, unknown>
  detail?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const review = parseReview(content)
  if (!review)
    return (
      <Alert tone="warning">
        <AlertDescription>{t('review.unreadable')}</AlertDescription>
      </Alert>
    )
  if (!detail)
    return (
      <LiteratureResultReceipt
        title={review.title}
        description={t('review.receipt')}
        icon={<BookOpenCheck strokeWidth={1.5} />}
        openLabel={t('review.openReview')}
        onOpen={ports.openResults}
        openButtonSize="md"
      />
    )
  const body = review.artifacts.find((artifact) =>
    /06_output\/survey(?:[-_][^/]+)?\.(md|pdf|docx)$/.test(artifact.path)
  )
  return (
    <div data-testid="literature-review-card" className="grid min-w-0 gap-[var(--vds-space-3)]">
      <ReviewDocument review={review} openSource={ports.openSource} />
      {body && (
        <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
          <span>{body.title}</span>
          <Button variant="secondary" onClick={() => void ports.openArtifact(body.artifact_id)}>
            {t('review.openBody')}
          </Button>
        </div>
      )}
    </div>
  )
}
