import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

import type { SelectionAnchor } from '../../contracts/workbench'

const EMPTY_CONTRIBUTIONS: readonly SelectionActionContribution[] = []

export interface SelectionActionContribution {
  actions: ReactNode
  replacesDefaults?: boolean
  dismiss?: () => void
  expanded: boolean
  id: string
  order: number
  panel?: ReactNode
  annotateResult?: SelectionAnnotation
  replaceSelection?: SelectionReplacement
}

export interface SelectionAnnotationRequest {
  selection: SelectionAnchor
  body: string
}

export interface SelectionAnnotationResult {
  ok: boolean
}

export type SelectionAnnotation = (
  request: SelectionAnnotationRequest
) => Promise<SelectionAnnotationResult>

export interface SelectionReplacementRequest {
  selection: SelectionAnchor
  replacement: string
  expectedChangeVersion: number
  expectedFingerprint: string
}

export type SelectionReplacementError =
  | 'selection_changed'
  | 'replacement_failed'
  | 'replacement_timeout'
  | 'unsupported'

export type SelectionReplacementResult =
  | { ok: true }
  | { ok: false; error: SelectionReplacementError }

export type SelectionReplacement = (
  request: SelectionReplacementRequest
) => Promise<SelectionReplacementResult>

export function selectionReplacementFor(
  contributions: readonly SelectionActionContribution[]
): SelectionReplacement | null {
  return contributions.find((contribution) => contribution.replaceSelection)?.replaceSelection ?? null
}

export function selectionAnnotationFor(
  contributions: readonly SelectionActionContribution[]
): SelectionAnnotation | null {
  return contributions.find((contribution) => contribution.annotateResult)?.annotateResult ?? null
}

interface RegisteredContribution {
  contribution: SelectionActionContribution
  token: symbol
}

export class SelectionActionRegistry {
  private readonly entries = new Map<string, Map<string, RegisteredContribution>>()
  private readonly listeners = new Set<() => void>()
  private readonly snapshots = new Map<string, readonly SelectionActionContribution[]>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = (tabId: string): readonly SelectionActionContribution[] => (
    this.snapshots.get(tabId) ?? EMPTY_CONTRIBUTIONS
  )

  register(tabId: string, contribution: SelectionActionContribution): () => void {
    const token = Symbol(contribution.id)
    const tabEntries = this.entries.get(tabId) ?? new Map<string, RegisteredContribution>()
    tabEntries.set(contribution.id, { contribution, token })
    this.entries.set(tabId, tabEntries)
    this.publish(tabId)
    return () => {
      const registered = this.entries.get(tabId)?.get(contribution.id)
      if (registered?.token !== token) return
      this.entries.get(tabId)?.delete(contribution.id)
      if (this.entries.get(tabId)?.size === 0) this.entries.delete(tabId)
      this.publish(tabId)
    }
  }

  update(tabId: string, id: string, contribution: SelectionActionContribution): void {
    const registered = this.entries.get(tabId)?.get(id)
    if (!registered) return
    registered.contribution = contribution
    this.publish(tabId)
  }

  dismiss(tabId: string): void {
    for (const contribution of this.get(tabId)) contribution.dismiss?.()
  }

  private publish(tabId: string): void {
    const contributions = Array.from(
      this.entries.get(tabId)?.values() ?? [],
      (entry) => entry.contribution
    ).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    if (contributions.length) this.snapshots.set(tabId, contributions)
    else this.snapshots.delete(tabId)
    for (const listener of this.listeners) listener()
  }
}

export const selectionActionRegistry = new SelectionActionRegistry()
export const SelectionActionsContext = createContext(selectionActionRegistry)
export const useSelectionActionRegistry = (): SelectionActionRegistry => useContext(SelectionActionsContext)

export function useSelectionActionContribution(
  tabId: string,
  contribution: SelectionActionContribution
): void {
  const registry = useSelectionActionRegistry()
  useEffect(
    () => registry.register(tabId, contribution),
    [registry, tabId, contribution.id]
  )
  useEffect(
    () => registry.update(tabId, contribution.id, contribution),
    [registry, tabId, contribution]
  )
}

export function useSelectionActions(tabId: string): readonly SelectionActionContribution[] {
  const registry = useSelectionActionRegistry()
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.get(tabId),
    () => EMPTY_CONTRIBUTIONS
  )
}

export function dismissSelectionActions(tabId: string): void {
  selectionActionRegistry.dismiss(tabId)
}
