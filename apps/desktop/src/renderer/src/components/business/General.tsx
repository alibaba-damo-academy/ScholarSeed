import { useTranslation } from 'react-i18next'

import { useApp } from '../../store'
import { Alert, Button, Tabs, TabsList, TabsTrigger } from '../ui'
import { SettingsField, SettingsGroup, SettingsPage } from './Settings'
import {
  refreshFollowUpPreference,
  saveFollowUpPreference,
  useFollowUpPreference,
} from './followup'

export function GeneralSettings(): React.JSX.Element {
  const { state } = useApp()
  const { t } = useTranslation('components')
  const preference = useFollowUpPreference(state.serviceInstanceId)
  return (
    <SettingsPage
      data-testid="account-settings-general"
      title={t('followUp.general')}
      description={t('followUp.pageDescription')}
    >
      {preference.error && (
        <Alert
          tone="error"
          description={t('followUp.failed')}
          action={
            <Button variant="outline" onClick={() => void refreshFollowUpPreference()}>
              {t('followUp.retry')}
            </Button>
          }
        />
      )}
      <SettingsGroup>
        <SettingsField title={t('followUp.title')} description={t('followUp.description')}>
          <Tabs
            value={preference.mode}
            disabled={preference.loading || preference.saving || preference.error}
            onValueChange={(mode) => {
              if (mode === 'queue' || mode === 'steer') void saveFollowUpPreference(mode)
            }}
          >
            <TabsList
              className="w-max shrink-0"
              data-testid="follow-up-mode"
              aria-label={t('followUp.title')}
            >
              <TabsTrigger value="queue" data-testid="follow-up-queue">
                {t('followUp.queue')}
              </TabsTrigger>
              <TabsTrigger value="steer" data-testid="follow-up-steer">
                {t('followUp.steer')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </SettingsField>
      </SettingsGroup>
      <p className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
        {preference.loading
          ? t('followUp.loading')
          : preference.saving
            ? t('followUp.saving')
            : t('followUp.existingQueue')}
      </p>
    </SettingsPage>
  )
}
