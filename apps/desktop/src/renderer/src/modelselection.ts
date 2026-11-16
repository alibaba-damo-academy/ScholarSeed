// A pending write must survive a renderer reload while the same Serve instance
// can still complete it. Each request owns its own key, so concurrent results
// cannot clear one another. Session storage is scoped to this window/profile.
const PREFIX = 'scholarseed:model-selection:v1:'

export function createModelSelectionGuard(storage: Storage, makeId: () => string) {
  const active = new Set<string>()
  const prefix = (instance: string, session: string): string =>
    `${PREFIX}${encodeURIComponent(instance)}:${encodeURIComponent(session)}:`
  const guard = {
    begin(instance: string, session: string): string {
      if (guard.unknown(instance, session)) throw new Error('model_selection_unconfirmed')
      const key = prefix(instance, session) + makeId()
      storage.setItem(key, 'pending')
      active.add(key)
      return key
    },
    finish(key: string, confirmed: boolean): boolean {
      active.delete(key)
      if (!confirmed) return false
      try {
        storage.removeItem(key)
        return true
      } catch {
        return false
      }
    },
    unknown(instance: string, session: string): boolean {
      try {
        const start = prefix(instance, session)
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (key?.startsWith(start) && !active.has(key)) return true
        }
        return false
      } catch {
        // If the ledger cannot be read, recovery must not race an unknown write.
        return true
      }
    },
    blocked(instance: string | null | undefined, session: string): boolean {
      try {
        const start = instance ? prefix(instance, session) : null
        const sessionPart = `:${encodeURIComponent(session)}:`
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (
            key &&
            (start ? key.startsWith(start) : key.startsWith(PREFIX) && key.includes(sessionPart))
          )
            return true
        }
        return false
      } catch {
        return true
      }
    },
  }
  return guard
}

let guard: ReturnType<typeof createModelSelectionGuard> | undefined
export function modelSelectionGuard(): ReturnType<typeof createModelSelectionGuard> {
  return (guard ??= createModelSelectionGuard(window.sessionStorage, () => crypto.randomUUID()))
}

export function modelSelectionBlocked(
  instance: string | null | undefined,
  session: string
): boolean {
  try {
    return modelSelectionGuard().blocked(instance, session)
  } catch {
    return true
  }
}
