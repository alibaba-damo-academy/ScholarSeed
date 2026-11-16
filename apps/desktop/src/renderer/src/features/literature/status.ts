import { useSyncExternalStore } from 'react'
import type { NotificationFrame } from '../../../../notifications.ts'
import type { loadConversationLibraryStatus } from './api.ts'

const MEMBERSHIP_SUBJECT = 'membership:'
const MATCH_IDENTITY_SUBJECT = 'match-identity'
const CACHE_LIMIT = 64

type LibraryStatus = Awaited<ReturnType<typeof loadConversationLibraryStatus>>

export class LibraryStatusCache {
  private sequence = 0
  private resetRevision = 0
  private revisions = new Map<string, number>()
  private entries = new Map<
    string,
    { scope: string; request: Promise<LibraryStatus>; controller: AbortController }
  >()
  private listeners = new Set<() => void>()

  revision(scope: string): number {
    return this.revisions.get(scope) ?? this.resetRevision
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  invalidate(reset: boolean, changes: NotificationFrame['changes']): string[] | undefined {
    const scopes = new Set<string>()
    for (const { topic, subject } of changes) {
      if (topic !== 'literature') continue
      if (subject === MATCH_IDENTITY_SUBJECT) reset = true
      if (subject.startsWith(MEMBERSHIP_SUBJECT))
        scopes.add(subject.slice(MEMBERSHIP_SUBJECT.length))
    }
    if (reset) {
      this.resetRevision = ++this.sequence
      this.revisions.clear()
    } else {
      if (!scopes.size) return []
      for (const scope of scopes) this.revisions.set(scope, ++this.sequence)
    }
    for (const [key, entry] of this.entries) {
      if (reset || scopes.has(entry.scope)) {
        this.entries.delete(key)
        entry.controller.abort()
      }
    }
    for (const listener of this.listeners) listener()
    return reset ? undefined : [...scopes]
  }

  load(
    scope: string,
    cardKey: string,
    load: (signal: AbortSignal) => Promise<LibraryStatus>
  ): Promise<LibraryStatus> {
    const key = JSON.stringify([scope, cardKey])
    const cached = this.entries.get(key)
    if (cached) return cached.request
    const controller = new AbortController()
    const forget = (): void => {
      if (this.entries.get(key)?.controller === controller) this.entries.delete(key)
    }
    const request = load(controller.signal).then(
      (status) => {
        if (status.warning) forget()
        return status
      },
      (error: unknown) => {
        forget()
        throw error
      }
    )
    this.entries.set(key, { scope, request, controller })
    if (this.entries.size > CACHE_LIMIT) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    return request
  }
}

export const libraryStatusCache = new LibraryStatusCache()

export function useLibraryStatusRevision(scope: string): number {
  return useSyncExternalStore(libraryStatusCache.subscribe, () =>
    libraryStatusCache.revision(scope)
  )
}
