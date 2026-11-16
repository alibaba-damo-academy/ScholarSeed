import type { JSX } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button } from '../ui'

export function ConversationAlertExamples(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <>
      <Alert
        action={
          <Button size="sm" variant="outline">
            {t('alerts.continue')}
          </Button>
        }
        data-testid="conversation-alert-interrupted"
        description={t('alerts.interruptedDescription')}
        layout="stacked"
        title={t('alerts.interruptedTitle')}
        tone="warning"
      />
      <Alert
        action={
          <div className="flex gap-[var(--vds-space-2)]">
            <Button size="sm" variant="ghost">
              {t('alerts.restore')}
            </Button>
            <Button size="sm" variant="outline">
              {t('alerts.ignore')}
            </Button>
          </div>
        }
        data-testid="conversation-alert-recover"
        description={t('alerts.recoverDescription')}
        layout="stacked"
        title={t('alerts.recoverTitle')}
        tone="info"
      />
      <Alert
        action={
          <Button disabled loading size="sm" variant="outline">
            {t('alerts.retrying')}
          </Button>
        }
        data-testid="conversation-alert-retry"
        description={t('alerts.retryDescription')}
        layout="stacked"
        title={t('alerts.retryTitle')}
        tone="warning"
      />
    </>
  )
}

export function InlineAlertExamples(): JSX.Element {
  const { t } = useTranslation('examples')
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [actionOpen, setActionOpen] = useState(true)
  const [actionTaken, setActionTaken] = useState(false)
  return (
    <>
      {descriptionOpen && (
        <Alert
          className="!items-center"
          closable
          data-testid="alert-description-only"
          description={t('alert.descriptionOnly')}
          layout="inline"
          onClose={() => setDescriptionOpen(false)}
          tone="info"
        />
      )}
      {actionOpen && (
        <Alert
          action={
            <Button onClick={() => setActionTaken(true)} size="sm" variant="outline">
              {t('alert.exampleAction')}
            </Button>
          }
          className="!items-center"
          closable
          data-testid="alert-description-action"
          description={t(actionTaken ? 'alert.actionCompleted' : 'alert.descriptionAction')}
          layout="inline"
          onClose={() => setActionOpen(false)}
          tone="warning"
        />
      )}
    </>
  )
}
