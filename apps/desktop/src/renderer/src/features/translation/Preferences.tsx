import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui'
import { useTranslationBackend } from './context'
import { useTranslationText } from './text'

export function TranslationPreferenceStatus({
  showProgress = true,
}: {
  showProgress?: boolean
}): React.JSX.Element | null {
  const { backend, settings } = useTranslationBackend()
  const { t } = useTranslation('pdf')
  const { t: ui } = useTranslation('ui')
  const text = useTranslationText()
  if (settings?.preferencesError)
    return (
      <span role="alert" className="inline-flex flex-wrap items-center gap-[var(--vds-space-2)]">
        {t(
          settings.preferencesReady
            ? 'translation.preferencesSaveFailed'
            : 'translation.preferencesLoadFailed'
        )}
        {!settings.preferencesReady && backend?.load && (
          <Button size="sm" variant="outline" onClick={() => void backend.load?.()}>
            {t('reading.retry')}
          </Button>
        )}
      </span>
    )
  if (showProgress && (settings?.preferencesReady === false || settings?.preferencesSaving))
    return (
      <span role="status" className="text-[var(--vds-text-secondary)]">
        {settings.preferencesSaving ? text('saving') : ui('loading')}
      </span>
    )
  return null
}
