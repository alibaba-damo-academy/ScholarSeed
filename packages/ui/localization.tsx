import React from 'react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { ToastProvider, Toaster } from '../../apps/desktop/src/renderer/src/components/ui'
import zh from '../../apps/desktop/src/localization/locales/zh/literature.json'
import en from '../../apps/desktop/src/localization/locales/en/literature.json'
import zhUi from '../../apps/desktop/src/localization/locales/zh/ui.json'
import enUi from '../../apps/desktop/src/localization/locales/en/ui.json'
import zhAssistant from '../../apps/desktop/src/localization/locales/zh/assistant.json'
import enAssistant from '../../apps/desktop/src/localization/locales/en/assistant.json'
import zhComponents from '../../apps/desktop/src/localization/locales/zh/components.json'
import enComponents from '../../apps/desktop/src/localization/locales/en/components.json'
import zhConversation from '../../apps/desktop/src/localization/locales/zh/conversation.json'
import enConversation from '../../apps/desktop/src/localization/locales/en/conversation.json'
import zhResources from '../../apps/desktop/src/localization/locales/zh/resources.json'
import enResources from '../../apps/desktop/src/localization/locales/en/resources.json'
import zhWorkbench from '../../apps/desktop/src/localization/locales/zh/workbench.json'
import enWorkbench from '../../apps/desktop/src/localization/locales/en/workbench.json'

export const translator = i18next.createInstance()
export const ready = translator.init({
  resources: {
    zh: {
      literature: zh,
      ui: zhUi,
      assistant: zhAssistant,
      components: zhComponents,
      conversation: zhConversation,
      resources: zhResources,
      workbench: zhWorkbench,
    },
    en: {
      literature: en,
      ui: enUi,
      assistant: enAssistant,
      components: enComponents,
      conversation: enConversation,
      resources: enResources,
      workbench: enWorkbench,
    },
  },
  lng: 'zh',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <I18nextProvider i18n={translator}>
      <ToastProvider>
        {children}
        <Toaster />
      </ToastProvider>
    </I18nextProvider>
  )
}
