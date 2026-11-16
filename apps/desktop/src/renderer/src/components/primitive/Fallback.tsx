import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, Button } from '../ui'

export function EmptyAnswer({ onRetry }: { onRetry?: () => Promise<boolean> }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const retry = async (): Promise<void> => {
    if (!onRetry || pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      setFailed(!(await onRetry()))
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Alert
      tone="neutral"
      data-testid="empty-answer"
      className="items-center"
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={!onRetry}
          loading={busy}
          onClick={() => void retry()}
        >
          {t('answer.retry')}
        </Button>
      }
    >
      <AlertDescription truncate={false}>{t('answer.empty')}</AlertDescription>
      {!onRetry ? (
        <p className="m-0 text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-tertiary)]">
          {t('answer.retryUnavailable')}
        </p>
      ) : null}
      {failed ? <p role="alert">{t('answer.retryFailed')}</p> : null}
    </Alert>
  )
}
