export type ComposerDraftUpdate = string | ((current: string) => string)

export interface ComposerDraftStore {
  getSnapshot: () => string
  getRevision: () => number
  set: (update: ComposerDraftUpdate) => void
  subscribe: (listener: () => void) => () => void
}

export function createComposerDraftStore(initialValue = ''): ComposerDraftStore {
  let value = initialValue
  let revision = 0
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => value,
    getRevision: () => revision,
    set: (update) => {
      const next = typeof update === 'function' ? update(value) : update
      if (next === value) return
      value = next
      revision += 1
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function restoreComposerDraft(submitted: string, current: string): string {
  return current.trim() ? `${submitted}\n${current}` : submitted
}
