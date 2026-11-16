import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SETTINGS_PORTAL_NAME } from '../../../settings'
import { useToast } from '../components/ui'
import { NativeModalPortal, NativeModalProvider } from './Modal'

export const NativeSettingsPortal = NativeModalPortal

export function NativeSettingsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation('ui')
  const { toast } = useToast()
  return (
    <NativeModalProvider
      bridge={window.scholarseed.settingsPortal}
      name={SETTINGS_PORTAL_NAME}
      onFailure={() =>
        toast({ tone: 'error', title: t('settingsUnavailable'), dedupeKey: 'native-settings' })
      }
    >
      {children}
    </NativeModalProvider>
  )
}
