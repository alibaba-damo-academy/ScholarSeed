import type { i18n } from 'i18next'

import { applyLocalizationLanguage, createLocalization } from '../localization/engine'
import zh from '../localization/locales/zh/foundation.json'
import en from '../localization/locales/en/foundation.json'
import nativeZh from '../localization/locales/zh/native.json'
import nativeEn from '../localization/locales/en/native.json'
import accountZh from '../localization/locales/zh/account.json'
import accountEn from '../localization/locales/en/account.json'
import projectZh from '../localization/locales/zh/project.json'
import projectEn from '../localization/locales/en/project.json'
import { DEFAULT_LANGUAGE, FOUNDATION_NAMESPACE } from '../localization/catalog'
import type { PreferenceLanguage } from '../preferences'

let instance: i18n | undefined
const resources = {
  zh: { [FOUNDATION_NAMESPACE]: zh, native: nativeZh, account: accountZh, project: projectZh },
  en: { [FOUNDATION_NAMESPACE]: en, native: nativeEn, account: accountEn, project: projectEn },
}

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

/** Available before storage selection, without loading preferences or creating product directories. */
export function storageFailureMessage(path: string): string {
  const message = instance?.isInitialized
    ? instance.getFixedT(null, FOUNDATION_NAMESPACE)('startup.storageUnavailable')
    : resources[DEFAULT_LANGUAGE][FOUNDATION_NAMESPACE].startup.storageUnavailable
  return `${message}\n\n${path}`
}

/** Bundled text only: admission failure must not read untrusted storage preferences. */
export function startupAdmissionText(): typeof nativeZh.admissionRecovery {
  if (!instance?.isInitialized) return resources[DEFAULT_LANGUAGE].native.admissionRecovery
  const t = instance.getFixedT(null, 'native')
  return {
    title: t('admissionRecovery.title'),
    message: t('admissionRecovery.message'),
    detail: t('admissionRecovery.detail'),
    retry: t('admissionRecovery.retry'),
    copy: t('admissionRecovery.copy'),
    quit: t('admissionRecovery.quit'),
    installing: t('admissionRecovery.installing'),
    restoring: t('admissionRecovery.restoring'),
    unconfirmed: t('admissionRecovery.unconfirmed'),
  }
}
