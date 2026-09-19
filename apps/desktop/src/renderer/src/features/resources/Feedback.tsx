import { useTranslation } from 'react-i18next'

import { importFailureMessage, webSearchFailureText } from './search'
import type { ResourceErrorMessage } from './error'

type SearchFeedbackMessage =
  | { kind: 'failure' | 'fallback' | 'importFailure'; error?: string }
  | { kind: 'count'; messageKey: 'webFeedback.candidates' | 'webFeedback.partial' | 'webFeedback.saved'; total: number }
  | { kind: 'limit'; limit: number }
  | { kind: 'label'; messageKey:
    | 'webFeedback.failed' | 'webFeedback.completed' | 'webFeedback.browser'
    | 'webFeedback.requestFailed' | 'webFeedback.savedDescription' | 'webFeedback.saveFailed'
    | 'webFeedback.selectionLimitTitle'
    | 'webSearchFailure.webTitle' | 'webSearchFailure.browserTitle' }

/** Keep queued toast content subscribed to language without replacing the toast. */
export function SearchFeedback({ message }: { message: SearchFeedbackMessage }): React.JSX.Element {
  const { t } = useTranslation('resources')
  switch (message.kind) {
    case 'failure':
      return <>{message.error ? webSearchFailureText(t, message.error) : t('webSearch.retry')}</>
    case 'fallback':
      return <>{message.error
        ? t('webFeedback.browserReason', { reason: webSearchFailureText(t, message.error) })
        : t('webFeedback.browserDefault')}</>
    case 'importFailure':
      return <>{importFailureMessage(t, message.error)}</>
    case 'count':
      return <>{t(message.messageKey, { total: message.total })}</>
    case 'limit':
      return <>{t('webFeedback.selectionLimit', { limit: message.limit })}</>
    case 'label':
      return <>{t(message.messageKey)}</>
  }
}

export type DestinationFailure = ResourceErrorMessage | { key: 'webFeedback.projectUnavailable' }

export function ResourceFailure({ message }: { message: DestinationFailure }): React.JSX.Element {
  const { t } = useTranslation('resources')
  return <>{t(message.key)}{'detail' in message && message.detail ? <span> {message.detail}</span> : null}</>
}

export function DestinationFeedback({ message }: { message:
  | { key: 'destination.failed' | 'destination.created' }
  | { key: 'destination.createdDescription'; name: string }
}): React.JSX.Element {
  const { t } = useTranslation('resources')
  return <>{'name' in message ? t(message.key, { name: message.name }) : t(message.key)}</>
}
