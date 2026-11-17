import type { TranslationPreferences } from '../../../../translation'

export const TRANSLATION_LANGUAGES = [
  'zh-CN',
  'en',
  'ja',
  'fr',
  'de',
  'es',
  'ko',
  'ru',
  'ar',
  'pt',
  'it',
  'nl',
] as const
export const TRANSLATION_SERVICES = [
  { id: 'offline', fields: [] },
  { id: 'deepl', fields: ['apiKey'] },
  { id: 'youdao', fields: ['appId', 'appSecret'] },
  { id: 'baidu', fields: ['appId', 'appSecret'] },
  { id: 'aliyun', fields: ['accessKeyId', 'accessKeySecret', 'region'] },
  { id: 'volcengine', fields: ['accessKeyId', 'accessKeySecret', 'region'] },
  { id: 'google', fields: ['apiKey'] },
  { id: 'microsoft', fields: ['apiKey', 'region'] },
] as const
export const AI_ENGINE_PREFIX = 'ai:'
export const PUBLIC_SERVICE_FIELDS: readonly string[] = ['appId', 'region']
export const TRANSLATION_SCOPES = ['document', 'selection'] as const
export type TranslationScope = (typeof TRANSLATION_SCOPES)[number]
export type PackageStatus = 'missing' | 'installing' | 'installed' | 'failed'
export type ServiceStatus = 'unconfigured' | 'pending' | 'configured' | 'failed'
export interface TranslationChoice {
  engine: string
  source: string
  target: string
}
export interface TranslationState extends TranslationPreferences {
  loadError?: string
  preferencesReady?: boolean
  preferencesSaving?: boolean
  preferencesError?: string
  defaultEngine: string
  packages: Record<string, PackageStatus>
  services: Record<string, ServiceStatus>
  configuration: Record<string, Record<string, string>>
  choices: Record<string, Partial<Record<TranslationScope, TranslationChoice>>>
  focusService: string | null
}
export function initialTranslation(): TranslationState {
  return {
    toolbar: true,
    selectionAutomatic: false,
    defaultEngine: 'offline',
    packages: Object.fromEntries(
      TRANSLATION_LANGUAGES.map((language) => [
        language,
        language === 'zh-CN' || language === 'en' ? 'installed' : 'missing',
      ])
    ),
    services: Object.fromEntries(
      TRANSLATION_SERVICES.filter((service) => service.id !== 'offline').map((service) => [
        service.id,
        'unconfigured',
      ])
    ),
    configuration: {},
    choices: {},
    focusService: null,
  }
}
export function automaticSelection(state: TranslationState): boolean {
  return state.preferencesReady !== false && state.toolbar && state.selectionAutomatic
}
export function supportedLanguages(state: TranslationState, engine: string): readonly string[] {
  if (engine.startsWith(AI_ENGINE_PREFIX)) return ['zh-CN', 'en']
  if (engine === 'offline')
    return TRANSLATION_LANGUAGES.filter((language) => state.packages[language] === 'installed')
  return TRANSLATION_SERVICES.some((service) => service.id === engine) ? TRANSLATION_LANGUAGES : []
}
export function engineAvailable(state: TranslationState, engine: string): boolean {
  return (
    (engine === 'offline' && Object.values(state.packages).includes('installed')) ||
    engine.startsWith(AI_ENGINE_PREFIX) ||
    (TRANSLATION_SERVICES.some((service) => service.id === engine) &&
      state.services[engine] === 'configured')
  )
}
export function translationAllowed(state: TranslationState, choice: TranslationChoice): boolean {
  const languages = supportedLanguages(state, choice.engine)
  return (
    engineAvailable(state, choice.engine) &&
    languages.includes(choice.target) &&
    (choice.source === 'auto' ||
      (languages.includes(choice.source) && choice.source !== choice.target))
  )
}
export function translationChoice(
  state: TranslationState,
  document: string,
  scope: TranslationScope,
  target: string
): TranslationChoice {
  return state.choices[document]?.[scope] ?? { engine: state.defaultEngine, source: 'auto', target }
}
export function rememberChoice(
  state: TranslationState,
  document: string,
  scope: TranslationScope,
  choice: TranslationChoice
): TranslationState {
  return {
    ...state,
    choices: {
      ...state.choices,
      [document]: { ...state.choices[document], [scope]: { ...choice } },
    },
  }
}
export function translationDirty(
  draft: TranslationChoice,
  applied: TranslationChoice | undefined
): boolean {
  return Boolean(
    applied &&
    (draft.engine !== applied.engine ||
      draft.source !== applied.source ||
      draft.target !== applied.target)
  )
}
export function translationModelKey(
  choice: TranslationChoice,
  available: readonly string[]
): string {
  const key = choice.engine.startsWith(AI_ENGINE_PREFIX)
    ? choice.engine.slice(AI_ENGINE_PREFIX.length)
    : ''
  return available.includes(key) ? key : ''
}
