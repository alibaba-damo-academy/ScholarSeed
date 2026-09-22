import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { LiteratureNote } from '../../contracts/literature'
import {
  LiteratureApiError,
  addLiteratureNote,
  deleteLiteratureNote,
  updateLiteratureNote
} from './api'
import {
  draftOf,
  LITERATURE_NOTES_CHANGED,
  type NoteDraft,
  type NoteSaveStatus
} from './note'

const NOTE_VERSION_CONFLICT = 'literature_note_version_conflict'
const NOTE_AUTOSAVE_DELAY_MS = 1200

interface NoteAutoSaveOptions {
  itemId: string
  notes: LiteratureNote[]
  reload: () => Promise<void>
}

export interface NoteAutoSave {
  draft: NoteDraft | null
  selectedId: string | null
  isNew: boolean
  status: NoteSaveStatus
  error: string
  open: (note: LiteratureNote) => void
  openNew: () => void
  close: () => void
  requestOpen: (note: LiteratureNote) => void
  requestNew: () => void
  setTitle: (title: string) => void
  setText: (text: string) => void
  flush: () => Promise<boolean>
  remove: (noteId?: string) => Promise<boolean>
}

export function useNoteAutoSave(options: NoteAutoSaveOptions): NoteAutoSave {
  const { t } = useTranslation('literature')
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [status, setStatus] = useState<NoteSaveStatus>('saved')
  const [error, setError] = useState('')

  const draftRef = useRef<NoteDraft | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const isNewRef = useRef(false)
  const statusRef = useRef<NoteSaveStatus>('saved')
  const timerRef = useRef<number | null>(null)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const inFlightRef = useRef<Promise<boolean> | null>(null)

  const applyDraft = useCallback((next: NoteDraft | null) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const applyStatus = useCallback((next: NoteSaveStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const schedule = useCallback(() => {
    cancelTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flushRef.current()
    }, NOTE_AUTOSAVE_DELAY_MS)
  }, [cancelTimer])

  const flush = useCallback(async (): Promise<boolean> => {
    cancelTimer()
    if (inFlightRef.current) {
      if (!(await inFlightRef.current)) return false
      return flushRef.current()
    }
    const current = draftRef.current
    if (!current || statusRef.current !== 'dirty') return true
    if (!current.text.trim()) {
      if (isNewRef.current) return true
      if (!isNewRef.current) setError(t('notes.bodyRequired'))
      return false
    }
    applyStatus('saving')
    setError('')
    const snapshot = current
    const itemId = optionsRef.current.itemId
    const pending = (async (): Promise<boolean> => {
      try {
        const saved = isNewRef.current
          ? await addLiteratureNote(itemId, snapshot.text, snapshot.title)
          : await updateLiteratureNote(
              itemId,
              selectedIdRef.current ?? '',
              snapshot
            )
        if (isNewRef.current) {
          isNewRef.current = false
          setIsNew(false)
          selectedIdRef.current = saved.id
          setSelectedId(saved.id)
        }
        if (draftRef.current === snapshot) {
          applyDraft({
            title: saved.title,
            text: saved.text,
            version: saved.version
          })
          applyStatus('saved')
        } else {
          applyDraft({
            ...(draftRef.current ?? snapshot),
            version: saved.version
          })
          applyStatus('dirty')
          schedule()
        }
        window.dispatchEvent(
          new CustomEvent(LITERATURE_NOTES_CHANGED, { detail: itemId })
        )
        return true
      } catch (reason) {
        if (
          reason instanceof LiteratureApiError &&
          reason.failure.code === NOTE_VERSION_CONFLICT
        ) {
          setError(t('notes.versionConflict'))
        } else {
          setError(
            reason instanceof Error ? reason.message : t('notes.saveFailed')
          )
        }
        applyStatus('dirty')
        return false
      }
    })()
    inFlightRef.current = pending
    let saved: boolean
    try {
      saved = await pending
    } finally {
      inFlightRef.current = null
    }
    return saved && statusRef.current === 'dirty' ? flushRef.current() : saved
  }, [applyDraft, applyStatus, cancelTimer, schedule, t])

  flushRef.current = flush

  const open = useCallback(
    (note: LiteratureNote) => {
      cancelTimer()
      isNewRef.current = false
      setIsNew(false)
      selectedIdRef.current = note.id
      setSelectedId(note.id)
      applyDraft(draftOf(note))
      applyStatus('saved')
      setError('')
    },
    [applyDraft, applyStatus, cancelTimer]
  )

  const openNew = useCallback(() => {
    cancelTimer()
    isNewRef.current = true
    setIsNew(true)
    selectedIdRef.current = null
    setSelectedId(null)
    applyDraft({ title: '', text: '', version: 1 })
    applyStatus('saved')
    setError('')
  }, [applyDraft, applyStatus, cancelTimer])

  const close = useCallback(() => {
    cancelTimer()
    isNewRef.current = false
    setIsNew(false)
    selectedIdRef.current = null
    setSelectedId(null)
    applyDraft(null)
    applyStatus('saved')
    setError('')
  }, [applyDraft, applyStatus, cancelTimer])

  const requestOpen = useCallback(
    (note: LiteratureNote) => {
      if (statusRef.current === 'saved') {
        open(note)
        return
      }
      if (
        !inFlightRef.current &&
        isNewRef.current &&
        !draftRef.current?.text.trim()
      ) {
        open(note)
        return
      }
      void flush().then((saved) => {
        if (saved) open(note)
      })
    },
    [flush, open]
  )

  const requestNew = useCallback(() => {
    if (statusRef.current === 'saved') {
      openNew()
      return
    }
    if (
      !inFlightRef.current &&
      isNewRef.current &&
      !draftRef.current?.text.trim()
    ) {
      openNew()
      return
    }
    void flush().then((saved) => {
      if (saved) openNew()
    })
  }, [flush, openNew])

  const patch = useCallback(
    (next: NoteDraft) => {
      applyDraft(next)
      applyStatus('dirty')
      setError('')
      schedule()
    },
    [applyDraft, applyStatus, schedule]
  )

  const setTitle = useCallback(
    (title: string) => {
      const current = draftRef.current
      if (!current) return
      patch({ ...current, title })
    },
    [patch]
  )

  const setText = useCallback(
    (text: string) => {
      const current = draftRef.current
      if (!current) return
      patch({ ...current, text })
    },
    [patch]
  )

  const remove = useCallback(
    async (noteId?: string): Promise<boolean> => {
      if (inFlightRef.current && !(await flushRef.current())) return false
      const id = noteId ?? selectedIdRef.current
      if (!id) return false
      cancelTimer()
      try {
        await deleteLiteratureNote(optionsRef.current.itemId, id)
        setError('')
        await optionsRef.current.reload()
        window.dispatchEvent(
          new CustomEvent(LITERATURE_NOTES_CHANGED, {
            detail: optionsRef.current.itemId
          })
        )
        return true
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : t('notes.deleteFailed')
        )
        return false
      }
    },
    [cancelTimer, t]
  )

  useEffect(() => {
    const fresh = options.notes.find(
      (note) => note.id === selectedIdRef.current
    )
    if (
      fresh &&
      statusRef.current === 'saved' &&
      fresh.version !== draftRef.current?.version
    ) {
      applyDraft(draftOf(fresh))
    }
  }, [options.notes, applyDraft])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      void flushRef.current().then((saved) => {
        if (!saved)
          console.error('[literature-notes] could not save note on close')
      })
    }
  }, [cancelTimer])

  return {
    draft,
    selectedId,
    isNew,
    status,
    error,
    open,
    openNew,
    close,
    requestOpen,
    requestNew,
    setTitle,
    setText,
    flush,
    remove
  }
}
