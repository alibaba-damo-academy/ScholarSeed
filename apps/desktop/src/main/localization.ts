import type { i18n } from 'i18next'

import {
  applyLocalizationLanguage,
  createLocalization
} from '../localization/engine'
import zh from '../localization/locales/zh/foundation.json'
import en from '../localization/locales/en/foundation.json'
import nativeZh from '../localization/locales/zh/native.json'
import nativeEn from '../localization/locales/en/native.json'
import { DEFAULT_LANGUAGE, FOUNDATION_NAMESPACE } from '../localization/catalog'
import type { PreferenceLanguage } from '../preferences'

let instance: i18n | undefined
const resources = { zh: { [FOUNDATION_NAMESPACE]: zh, native: nativeZh }, en: { [FOUNDATION_NAMESPACE]: en, native: nativeEn } }

export function mainLocalization(): i18n {
  if (!instance) throw new Error('Main localization has not initialized')
  return instance
}

export async function applyMainLanguage(language: PreferenceLanguage): Promise<void> {
  if (!instance) instance = createLocalization(language, resources)
  else await applyLocalizationLanguage(instance, language)
}

/** Failure reporting must remain available even if localization initialization failed. */
export function startupFailureTitle(): string {
  return instance?.isInitialized
    ? instance.getFixedT(null, FOUNDATION_NAMESPACE)('startup.applicationFailed')
    : resources[DEFAULT_LANGUAGE][FOUNDATION_NAMESPACE].startup.applicationFailed
}
