import { createInstance, type i18n, type Resource, type PostProcessorModule, type InitOptions } from 'i18next'

import fallbackMessages from './locales/zh/foundation.json' with { type: 'json' }
import { DEFAULT_LANGUAGE, FOUNDATION_NAMESPACE, LOCALES } from './catalog.ts'
import type { PreferenceLanguage } from '../preferences.ts'

export interface LocalizationDiagnostic {
  kind: 'missing' | 'fallback' | 'initialized' | 'changed'
  language: string
  namespace?: string
  key?: string
}

/** Diagnostic metadata deliberately excludes interpolation values and resource text. */
export function reportLocalization(event: LocalizationDiagnostic): void {
  console.info('[localization]', event)
}

const DIAGNOSTIC_PROCESSOR = 'localization-diagnostics'
const diagnostics: PostProcessorModule = {
  type: 'postProcessor',
  name: DIAGNOSTIC_PROCESSOR,
  process(value, keys, options, translator) {
    const report = translator.options.localizationReporter as (event: LocalizationDiagnostic) => void
    const details = options.i18nResolved as { res?: unknown; usedLng?: string; usedNS?: string } | undefined
    const key = Array.isArray(keys) ? keys[0] : keys
    const language = typeof options.lng === 'string' ? options.lng : translator.language as string
    if (details?.res === undefined) report({ kind: 'missing', language, key })
    else if (details.usedLng !== language) report({ kind: 'fallback', language, key, namespace: details.usedNS })
    return value
  }
}

export function createLocalization(
  language: PreferenceLanguage,
  resources: Resource,
  options: { report?: (event: LocalizationDiagnostic) => void; escapeValue?: boolean } = {}
): i18n {
  const report = options.report ?? reportLocalization
  const namespaces = Object.keys(resources[DEFAULT_LANGUAGE] ?? {})
  if (!namespaces.length || !resources[language]) report({ kind: 'missing', language, namespace: FOUNDATION_NAMESPACE })
  const foundation = resources[DEFAULT_LANGUAGE]?.[FOUNDATION_NAMESPACE]
  const bundledResources = {
    ...resources,
    [DEFAULT_LANGUAGE]: {
      ...resources[DEFAULT_LANGUAGE],
      [FOUNDATION_NAMESPACE]: { ...fallbackMessages, ...(typeof foundation === 'object' ? foundation : {}) }
    }
  }
  const instance = createInstance()
  instance.use(diagnostics)
  instance.on('languageChanged', (language) => report({ kind: 'changed', language }))
  // Bundled resources initialize synchronously: the first render never races a backend fetch.
  const configuration: InitOptions & { localizationReporter: typeof report } = {
    lng: language,
    supportedLngs: Object.keys(LOCALES),
    fallbackLng: DEFAULT_LANGUAGE,
    resources: bundledResources,
    defaultNS: FOUNDATION_NAMESPACE,
    ns: Object.keys(bundledResources[DEFAULT_LANGUAGE]),
    initAsync: false,
    saveMissing: false,
    returnEmptyString: false,
    interpolation: { escapeValue: options.escapeValue ?? true },
    parseMissingKeyHandler: () => fallbackMessages.startup.failed,
    postProcess: [DIAGNOSTIC_PROCESSOR],
    postProcessPassResolved: true,
    localizationReporter: report
  }
  void instance.init(configuration)
  if (!instance.isInitialized) throw new Error('Localization initialization did not complete')
  report({ kind: 'initialized', language })
  return instance
}

/** Applying an already active language must not emit another global change. */
export async function applyLocalizationLanguage(
  instance: i18n,
  language: PreferenceLanguage
): Promise<void> {
  if (instance.language === language) return
  await instance.changeLanguage(language)
}
