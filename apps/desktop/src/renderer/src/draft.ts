export type ComposerDraftUpdate = string | ((current: string) => string)

export interface ComposerDraftStore {
  getSnapshot: () => string
  set: (update: ComposerDraftUpdate) => void
  subscribe: (listener: () => void) => () => void
}

export function createComposerDraftStore(initialValue = ''): ComposerDraftStore {
  let value = initialValue
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => value,
    set: (update) => {
      const next = typeof update === 'function' ? update(value) : update
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function restoreComposerDraft(submitted: string, current: string): string {
  return current.trim() ? `${submitted}\n${current}` : submitted
}
