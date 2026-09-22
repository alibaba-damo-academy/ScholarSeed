import type { PreferenceLanguage } from '../preferences'

export const DEFAULT_LANGUAGE: PreferenceLanguage = 'zh'
export const LOCALES = {
  zh: { label: '简体中文', tag: 'zh-CN', office: 'zh-CN' },
  en: { label: 'English', tag: 'en-US', office: 'en-US' }
} as const satisfies Record<PreferenceLanguage, { label: string; tag: string; office: string }>
export const FOUNDATION_NAMESPACE = 'foundation'
