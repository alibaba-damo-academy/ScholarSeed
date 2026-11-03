import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui'
import type { LiteratureCardPorts } from './ports'
import { downloadOutcome, parseDownloadCard } from './admission'

export function LiteratureDownloads({
  content,
  ports,
}: {
  cardId: string
  ports: LiteratureCardPorts
  content: Record<string, unknown>
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [openError, setOpenError] = useState(false)
  const card = parseDownloadCard(content)
  if (!card) return <Alert tone="warning" description={t('downloads.unreadable')} />
  const outcome = downloadOutcome(card)
  return (
    <Card
      className="min-w-0 [--vds-card-radius:var(--vds-radius-6)]"
      data-testid="literature-downloads-card"
    >
      <CardHeader>
        <CardTitle>
          {t(outcome.heading, { count: outcome.saved, failed: outcome.failed })}
        </CardTitle>
        <CardDescription>{t(outcome.descriptionKey)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-[var(--vds-space-3)]">
          {card.papers.map((paper) => (
            <div
              key={paper.paper_id}
              className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-hover)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
            >
              <span className="min-w-0 flex-1 break-words text-[var(--vds-text-primary)]">
                {paper.title}
              </span>
              <Button
                size="sm"
                variant="outline"
                data-testid="literature-download-open"
                onClick={async () => {
                  setOpenError(false)
                  try {
                    if (!(await ports.openFulltext(paper.paper_id))) setOpenError(true)
                  } catch {
                    setOpenError(true)
                  }
                }}
              >
                {t('downloads.openFulltext')}
              </Button>
            </div>
          ))}
          {(card.omitted_papers ?? 0) > 0 && card.papers[0] && (
            <Button
              variant="outline"
              data-testid="literature-download-library"
              onClick={() => void ports.openLibrary()}
            >
              {t('downloads.viewLibrary', { count: card.omitted_papers ?? 0 })}
            </Button>
          )}
          {outcome.failed > 0 && (
            <Alert tone="warning" description={t('downloads.failed', { count: outcome.failed })} />
          )}
          {openError && <Alert tone="warning" description={t('downloads.openFailed')} />}
        </div>
      </CardContent>
    </Card>
  )
}
