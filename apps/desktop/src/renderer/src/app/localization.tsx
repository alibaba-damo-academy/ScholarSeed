import React from 'react'
import { I18nextProvider } from 'react-i18next'

import {
  applyLocalizationLanguage,
  createLocalization
} from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import { DEFAULT_LANGUAGE, LOCALES } from '../../../localization/catalog'
import type { PreferenceLanguage } from '../../../preferences'

export const rendererLocalization = createLocalization(window.scholarseed?.preferences.language ?? DEFAULT_LANGUAGE, resources, { escapeValue: false })

document.documentElement.lang = LOCALES[rendererLocalization.language as PreferenceLanguage].tag

export async function applyRendererLanguage(language: PreferenceLanguage): Promise<void> {
  await applyLocalizationLanguage(rendererLocalization, language)
  document.documentElement.lang = LOCALES[language].tag
}

export function LocalizationProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <I18nextProvider i18n={rendererLocalization}>{children}</I18nextProvider>
}
