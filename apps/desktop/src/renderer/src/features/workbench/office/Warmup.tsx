import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp } from 'lucide-react'

import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ProgressBar,
  Spinner
} from '../../../components/ui'
import {
  officeWarmupProgress,
  type OfficeWarmupStatus
} from './progress'

const MEBIBYTE = 1024 * 1024

export function OfficeWarmup({
  onRetry,
  status
}: {
  onRetry: () => void
  status: OfficeWarmupStatus
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const [open, setOpen] = React.useState(false)
  if (status.stage === 'ready') return null
  const progress = officeWarmupProgress(status)
  const expanded = status.stage === 'error' || open
  const detail = status.stage === 'reading'
    ? t('officeWarmup.reading', {
        done: status.done,
        total: status.total,
        size: (status.loadedBytes / MEBIBYTE).toFixed(1)
      })
    : t(`officeWarmup.${status.stage}`)

  return (
    <Collapsible
      className="fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] z-[var(--vds-z-background-task)] w-[calc(var(--vds-popover-width-md)-var(--vds-space-10))]"
      data-testid="office-font-warmup"
      onOpenChange={setOpen}
      open={expanded}
    >
      <Card
        className="flex flex-col-reverse overflow-hidden shadow-[var(--vds-shadow-lg)]"
        padding="none"
        variant="elevated"
      >
        <CollapsibleTrigger asChild>
          <Button
            aria-label={t('officeWarmup.title')}
            className="h-auto w-full flex-col items-stretch gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
            variant="ghost"
          >
            <span className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
              <Spinner className="shrink-0" size="sm" />
              <span className="min-w-0 flex-1 truncate text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                {t('officeWarmup.title')}
              </span>
              {progress === null ? null : (
                <span className="shrink-0 text-[length:var(--vds-font-caption)] tabular-nums text-[var(--vds-text-secondary)]">
                  {progress}%
                </span>
              )}
              <ChevronUp
                aria-hidden="true"
                className={`shrink-0 transition-transform duration-[var(--vds-duration-fast)] ${expanded ? 'rotate-180' : ''}`}
                size={14}
                strokeWidth={1.6}
              />
            </span>
            <ProgressBar
              className="[&_.vds-progress-bar__label]:sr-only"
              indeterminate={progress === null}
              label={detail}
              value={progress ?? undefined}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="grid gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-3)]">
            <ProgressBar
              indeterminate={progress === null}
              label={detail}
              value={progress ?? undefined}
            />
            {status.stage === 'error' ? (
              <Button onClick={onRetry} size="sm" variant="secondary">
                {t('officeWarmup.retry')}
              </Button>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
