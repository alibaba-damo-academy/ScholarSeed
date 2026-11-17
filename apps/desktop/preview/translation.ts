import {
  initialTranslation,
  rememberChoice,
  translationAllowed,
  TRANSLATION_SERVICES,
} from '../src/renderer/src/features/translation/model.ts'
import type {
  TranslationChoice,
  TranslationState,
} from '../src/renderer/src/features/translation/model.ts'
import type { TranslationBackend } from '../src/renderer/src/features/translation/context.tsx'

const SIMULATION_DELAY_MS = 700
const STORAGE_PREFIX = 'pdfe.translation.'
const SAMPLE_TRANSLATIONS: Record<string, string> = {
  'zh-CN':
    '【模拟译文】在收获前给出可靠的产量预报，有助于种植者和粮食部门安排仓储、贸易与保险。我们提出一种物候感知的注意力模型，为每次观测赋权，同时保留专业术语、引用和段落结构。',
  en: '[Simulated translation] Reliable yield forecasts before harvest help growers plan storage, trade and insurance. We propose a phenology-aware attention model that preserves terminology, citations and paragraph structure.',
  ja: '【翻訳デモ】収穫前の信頼できる収量予測は、生産者の貯蔵や取引の計画に役立ちます。',
  fr: '[Traduction simulée] Des prévisions fiables du rendement avant la récolte facilitent la planification du stockage et du commerce.',
  de: '[Simulierte Übersetzung] Zuverlässige Ertragsprognosen vor der Ernte unterstützen die Planung von Lagerung und Handel.',
  es: '[Traducción simulada] Las previsiones fiables antes de la cosecha facilitan la planificación del almacenamiento y el comercio.',
}
const wait = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, SIMULATION_DELAY_MS)
    signal?.addEventListener('abort', abort, { once: true })
  })

export function createPreviewTranslation(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  instance: string,
  scene: string,
  generation = instance
): TranslationBackend {
  const key = STORAGE_PREFIX + JSON.stringify([instance, scene, generation])
  let state = initialTranslation()
  const saved = storage.getItem(key)
  if (saved) {
    const parsed = JSON.parse(saved) as TranslationState
    state = {
      ...state,
      ...parsed,
      focusService: null,
      packages: Object.fromEntries(
        Object.entries(parsed.packages ?? state.packages).map(([language, status]) => [
          language,
          status === 'installing' ? 'failed' : status,
        ])
      ),
      services: Object.fromEntries(
        Object.entries(parsed.services ?? state.services).map(([service, status]) => [
          service,
          status === 'pending' ? 'failed' : status,
        ])
      ),
    }
  } else if (scene === 'translation-toolbar-disabled') state.toolbar = false
  const listeners = new Set<() => void>()
  const commit = (next: TranslationState): void => {
    storage.setItem(key, JSON.stringify({ ...next, focusService: null }))
    state = next
    listeners.forEach((listener) => listener())
  }
  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (patch) => commit({ ...state, ...patch }),
    choose: (document, scope, choice) => commit(rememberChoice(state, document, scope, choice)),
    invalidate: (service) => {
      if (state.services[service] !== 'pending')
        commit({ ...state, services: { ...state.services, [service]: 'unconfigured' } })
    },
    verify: async (service, fields) => {
      const definition = TRANSLATION_SERVICES.find((item) => item.id === service)
      if (
        !definition ||
        !definition.fields.length ||
        definition.fields.some((field) => !fields[field]?.trim()) ||
        state.services[service] === 'pending'
      )
        return false
      commit({ ...state, services: { ...state.services, [service]: 'pending' } })
      await wait()
      const success = scene !== 'translation-verification-failed'
      commit({
        ...state,
        services: { ...state.services, [service]: success ? 'configured' : 'failed' },
      })
      return success
    },
    install: async (language) => {
      if (
        !Object.prototype.hasOwnProperty.call(state.packages, language) ||
        state.packages[language] === 'installing' ||
        state.packages[language] === 'installed'
      )
        return false
      commit({ ...state, packages: { ...state.packages, [language]: 'installing' } })
      await wait()
      const success = scene !== 'translation-installation-failed'
      commit({
        ...state,
        packages: { ...state.packages, [language]: success ? 'installed' : 'failed' },
      })
      return success
    },
    translate: async (choice: TranslationChoice, _source: string, signal: AbortSignal) => {
      if (!translationAllowed(state, choice)) throw new Error('translation_unavailable_direction')
      await wait(signal)
      signal.throwIfAborted()
      return (
        SAMPLE_TRANSLATIONS[choice.target] ??
        `[Simulated translation · ${choice.target}] Reliable yield forecasts help growers plan storage, trade and insurance.`
      )
    },
  }
}
