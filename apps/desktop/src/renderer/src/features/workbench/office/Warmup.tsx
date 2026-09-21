import React from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent, CardHeader, CardTitle } from '../../../components/ui'
import { type OfficeWarmupStatus } from './progress'

export function OfficeWarmup({
  onRetry,
  status
}: {
  onRetry: () => void
  status: OfficeWarmupStatus
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  if (status.stage !== 'error') return null

  return (
    <Card
      className="fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] z-[var(--vds-z-background-task)] w-[calc(var(--vds-popover-width-md)-var(--vds-space-10))]"
      data-testid="office-font-warmup"
      variant="elevated"
    >
      <CardHeader className="pb-[var(--vds-space-2)]">
        <CardTitle>{t('officeWarmup.error')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Button onClick={onRetry} size="sm" variant="secondary">
          {t('officeWarmup.retry')}
        </Button>
      </CardContent>
    </Card>
  )
}
