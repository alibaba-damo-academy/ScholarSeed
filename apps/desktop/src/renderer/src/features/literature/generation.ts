import { useSyncExternalStore } from 'react'

import type { GenerationPreviewData } from '../../api'
import type { LiteratureNote } from '../../contracts/literature'
import { generateLiteratureNote, NoteGenerationFailure } from './api'
import { catalogue } from './catalog'
import type { InsightRequest } from './insights'
import { LITERATURE_NOTES_CHANGED } from './note'

interface GenerationState {
  pending: boolean
  count: number
  error: boolean
  diagnostic: string
  note: LiteratureNote | null
  preview: GenerationPreviewData | null
}

const EMPTY: GenerationState = {
  pending: false,
  count: 0,
  error: false,
  diagnostic: '',
  note: null,
  preview: null,
}
const states = new Map<string, GenerationState>()
const listeners = new Set<() => void>()
const publish = (itemId: string, state: GenerationState): void => {
  states.set(itemId, state)
  listeners.forEach((listener) => listener())
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useNoteGeneration(itemId: string): GenerationState {
  return useSyncExternalStore(subscribe, () => states.get(itemId) ?? EMPTY)
}

export async function generateNote(
  itemId: string,
  request: InsightRequest,
  flush: () => Promise<boolean>
): Promise<void> {
  if (states.get(itemId)?.pending) return
  const pending = { ...EMPTY, pending: true, count: request.mark_ids.length }
  publish(itemId, pending)
  try {
    if (!(await flush())) throw new Error('note_save_failed')
    const note = await generateLiteratureNote(itemId, request, (preview) => {
      const current = states.get(itemId) ?? pending
      if (
        !current.pending ||
        preview.verified !== false ||
        (current.preview?.preview_id === preview.preview_id &&
          (current.preview.revision >= preview.revision ||
            (current.preview.status !== 'streaming' && preview.status === 'streaming')))
      )
        return
      publish(itemId, { ...current, preview })
    })
    publish(itemId, { ...pending, pending: false, note })
    window.dispatchEvent(new CustomEvent(LITERATURE_NOTES_CHANGED, { detail: itemId }))
    catalogue.reload()
  } catch (error) {
    console.error('[literature-notes] generation failed', error)
    const diagnostic =
      error instanceof NoteGenerationFailure
        ? [error.message, error.invocationId, error.detail].filter(Boolean).join('\n')
        : ''
    publish(itemId, { ...(states.get(itemId) ?? pending), pending: false, error: true, diagnostic })
    window.dispatchEvent(new CustomEvent(LITERATURE_NOTES_CHANGED, { detail: itemId }))
  }
}
