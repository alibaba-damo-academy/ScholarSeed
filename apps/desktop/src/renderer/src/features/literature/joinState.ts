import { useSyncExternalStore } from 'react'
import type { JoinDestination } from './hierarchy'
import { catalogue } from './catalog'

const listeners = new Set<() => void>()
let receipts: ReadonlyMap<string, JoinDestination> = new Map()
export function expireJoinedPapers(scopes?: readonly string[]): void {
  const next = scopes
    ? new Map([...receipts].filter(([key]) => !scopes.includes((JSON.parse(key) as [string])[0])))
    : new Map<string, JoinDestination>()
  if (next.size === receipts.size) return
  receipts = next
  listeners.forEach((listener) => listener())
}

export function recordJoined(keys: string[], destination: JoinDestination): void {
  receipts = new Map([...receipts, ...keys.map((key) => [key, destination] as const)])
  listeners.forEach((listener) => listener())
  catalogue.reload()
}
export function useJoinedPapers(): ReadonlyMap<string, JoinDestination> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => receipts
  )
}
export interface CreatedCollectionNotice {
  id: string
  projectId?: string
  ancestors: string[]
}
const createdListeners = new Set<(notice: CreatedCollectionNotice) => void>()
export function onJoinedCollectionCreated(
  listener: (notice: CreatedCollectionNotice) => void
): () => void {
  createdListeners.add(listener)
  return () => {
    createdListeners.delete(listener)
  }
}
export function joinedCollectionCreated(notice: CreatedCollectionNotice): void {
  createdListeners.forEach((listener) => listener(notice))
  catalogue.reload()
}
