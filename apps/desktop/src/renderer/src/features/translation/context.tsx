import React, { createContext, useContext, useSyncExternalStore } from 'react'
import type { TranslationChoice, TranslationScope, TranslationState } from './model'

export interface TranslationBackend {
  live?: boolean
  snapshot: () => TranslationState
  subscribe: (listener: () => void) => () => void
  load?: () => Promise<void>
  update: (
    patch: Partial<
      Pick<TranslationState, 'toolbar' | 'selectionAutomatic' | 'defaultEngine' | 'focusService'>
    >
  ) => void | Promise<void>
  choose: (document: string, scope: TranslationScope, choice: TranslationChoice) => void
  invalidate: (service: string) => void
  verify: (
    service: string,
    fields: Record<string, string>,
    onRecovered?: () => void
  ) => Promise<boolean>
  install: (language: string) => Promise<boolean>
  translate: (
    choice: TranslationChoice,
    source: string,
    signal: AbortSignal,
    onRecovered?: () => void
  ) => Promise<string>
}
export const TranslationContext = createContext<TranslationBackend | null>(null)
const absent = (): null => null
const noopSubscribe = (): (() => void) => () => undefined
export function useTranslationBackend(): {
  backend: TranslationBackend | null
  settings: TranslationState | null
} {
  const backend = useContext(TranslationContext)
  const settings = useSyncExternalStore(
    backend?.subscribe ?? noopSubscribe,
    backend?.snapshot ?? absent
  )
  return { backend, settings }
}
export function TranslationProvider({
  backend,
  children,
}: {
  backend: TranslationBackend
  children: React.ReactNode
}): React.JSX.Element {
  return <TranslationContext.Provider value={backend}>{children}</TranslationContext.Provider>
}
