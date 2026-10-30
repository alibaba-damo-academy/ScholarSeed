interface ComposerSubmissionEntry {
  sessionId: string | null
  disabled: boolean
  submit: (message: string) => Promise<boolean>
}

/** One mounted product composer, scoped to its StoreProvider rather than a window global. */
export function createComposerSubmission() {
  let entry: ComposerSubmissionEntry | null = null
  let pending = false
  const consumed = new Map<string, Set<string>>()
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach((listener) => listener())
  const wasConsumed = (sessionId: string, actionId: string): boolean =>
    consumed.get(sessionId)?.has(actionId) ?? false
  const getSnapshot = (): string | null =>
    entry && !entry.disabled && !pending ? entry.sessionId : null

  return {
    getSnapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(next: ComposerSubmissionEntry): () => void {
      entry = next
      notify()
      return () => {
        if (entry !== next) return
        entry = null
        notify()
      }
    },
    consumed: wasConsumed,
    async submit(sessionId: string, actionId: string, message: string): Promise<boolean> {
      const current = entry
      if (
        !sessionId ||
        !actionId ||
        !message.trim() ||
        pending ||
        !current ||
        current.disabled ||
        current.sessionId !== sessionId ||
        wasConsumed(sessionId, actionId)
      ) {
        return false
      }
      pending = true
      notify()
      try {
        const accepted = await current.submit(message)
        if (accepted) {
          const actions = consumed.get(sessionId) ?? new Set<string>()
          actions.add(actionId)
          consumed.set(sessionId, actions)
        }
        return accepted
      } finally {
        pending = false
        notify()
      }
    },
  }
}

export type ComposerSubmission = ReturnType<typeof createComposerSubmission>
