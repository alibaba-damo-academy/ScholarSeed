import type {
  AssistantContextRef,
  ComposerReference,
  ProjectContextPolicy,
  SearchScope,
} from './contracts/assistant'
const REFERENCE_TYPES = ['file', 'directory', 'skill']
const PROJECT_POLICIES = ['auto_project', 'explicit_only']
const SEARCH_SCOPES = ['disabled', 'academic', 'web']

export interface ConversationDraft {
  text: string
  refs: ComposerReference[]
  context?: {
    refs: AssistantContextRef[]
    projectPolicy: ProjectContextPolicy
    searchScope: SearchScope
  }
}

export function composerDraftKey(sessionId: string | null, scopeKey: string | null): string | null {
  return sessionId
    ? JSON.stringify(['session', sessionId])
    : scopeKey
      ? JSON.stringify(['scope', scopeKey])
      : null
}

export function readComposerDrafts(raw: string | null | undefined): Map<string, ConversationDraft> {
  if (!raw) return new Map()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()
    return new Map(
      parsed
        .filter((entry): entry is [string, ConversationDraft] => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
            return false
          const draft = entry[1]
          return (
            draft !== null &&
            typeof draft === 'object' &&
            typeof draft.text === 'string' &&
            Array.isArray(draft.refs) &&
            draft.refs.every(
              (reference: ComposerReference) =>
                reference !== null &&
                typeof reference === 'object' &&
                REFERENCE_TYPES.includes(reference.type) &&
                typeof reference.id === 'string' &&
                typeof reference.title === 'string' &&
                typeof reference.path === 'string'
            ) &&
            (!draft.context ||
              (Array.isArray(draft.context.refs) &&
                draft.context.refs.every(
                  (reference: AssistantContextRef) =>
                    reference !== null &&
                    typeof reference === 'object' &&
                    typeof reference.ref_id === 'string' &&
                    typeof reference.kind === 'string' &&
                    typeof reference.source_id === 'string' &&
                    typeof reference.label === 'string'
                ) &&
                PROJECT_POLICIES.includes(draft.context.projectPolicy) &&
                SEARCH_SCOPES.includes(draft.context.searchScope)))
          )
        })
        .map(([key, draft]) => [
          key,
          {
            ...draft,
            refs: draft.refs.map((reference) =>
              reference.type !== 'skill' && reference.localSource
                ? { ...reference, localSource: {} }
                : reference
            ),
          },
        ])
    )
  } catch {
    return new Map()
  }
}

export function serializeComposerDrafts(drafts: ReadonlyMap<string, ConversationDraft>): string {
  return JSON.stringify([...drafts], (key, value) => (key === 'localSource' ? {} : value))
}

export type ComposerDraftUpdate = string | ((current: string) => string)

export interface ComposerDraftStore {
  getSnapshot: () => string
  getRevision: () => number
  getScope: () => number
  reset: (value?: string) => void
  set: (update: ComposerDraftUpdate) => void
  subscribe: (listener: () => void) => () => void
}

export function createComposerDraftStore(initialValue = ''): ComposerDraftStore {
  let value = initialValue
  let revision = 0
  let scope = 0
  const listeners = new Set<() => void>()
  const set = (update: ComposerDraftUpdate): void => {
    const next = typeof update === 'function' ? update(value) : update
    if (next === value) return
    value = next
    revision += 1
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => value,
    getRevision: () => revision,
    getScope: () => scope,
    reset: (next = '') => {
      scope += 1
      set(next)
    },
    set,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function restoreComposerDraft(submitted: string, current: string): string {
  return current.trim() ? `${submitted}\n${current}` : submitted
}
